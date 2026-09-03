import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { recordCriticalAudit } from './audit.js';
import { getBlobStore } from './blobStore.js';
import { logger } from './logger.js';
import { ADMIN_EMAIL_HR_ONLY, notifyAllAdmins, notifyUser } from './notify.js';

/**
 * Onboarding ghost purge — the self-cleaning half of the invite pipeline.
 *
 * Two populations are pure noise and get hard-deleted (rows, files, login),
 * so the directory / pending lists / audit tooling only ever show real
 * people. A deleted ghost's email becomes free again, so the only way back
 * in is a brand-new invitation:
 *
 *   1. INVITED, never accepted — no password set within
 *      INVITE_PURGE_AFTER_DAYS (3) of the last HUMAN-caused invite
 *      (original invite, HR resend, self-service renew; the automatic 48h
 *      reminder does NOT restart the clock). They already got that 48h
 *      reminder; nothing of theirs exists beyond a name and an email.
 *
 *   2. Accepted, then abandoned — password set but every application still
 *      an unsubmitted DRAFT after IDLE_PURGE_AFTER_DAYS (10) with zero
 *      onboarding activity (no task completed, no document uploaded, no
 *      fresh link consumed). The clock measures INACTIVITY, not elapsed
 *      time — someone actively working through the checklist is never
 *      eligible. A final notice goes out at FINAL_NOTICE_AFTER_DAYS (8)
 *      idle, and the purge additionally requires that notice to be at
 *      least FINAL_NOTICE_MIN_GAP_HOURS (48) old, so nobody is ever
 *      deleted un-warned — including pre-existing ghosts on rollout.
 *
 * HARD GUARDS — a candidate is skipped (forever, not deferred) if ANY of:
 *   - an application that was ever submitted/approved/rejected,
 *   - hireDate stamped, a Separation row, deactivatedAt / separatedAt /
 *     erasedAt / deletedAt set (the reactivation & rehire populations keep
 *     their history — that's the point of those features),
 *   - any TimeEntry, PayrollItem, ExternalPayment, assigned Shift, or
 *     kiosk punch. Ghosts have no work history by definition.
 *   - a link email (any token) minted within the last RECENT_LINK_GUARD_H
 *     hours — never purge someone hours after we mailed them a live link.
 *
 * Deletion is genuinely hard (unlike lib/erasure.ts, which anonymizes
 * employees with retained payroll/tax history): these people never worked
 * a minute, so no retention duty attaches — and destroying the I-9/SSN
 * documents of people who never became employees is a privacy win. Every
 * purge writes a permanent critical-audit row with the identity in
 * metadata, and each sweep with deletions sends admins one summary.
 */

export const INVITE_PURGE_AFTER_DAYS = 3;
export const IDLE_PURGE_AFTER_DAYS = 10;
export const FINAL_NOTICE_AFTER_DAYS = 8;
export const FINAL_NOTICE_MIN_GAP_HOURS = 48;
/** Never purge within a day of ANY invite link being emailed. */
export const RECENT_LINK_GUARD_HOURS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeSweepResult {
  scannedInvited: number;
  scannedAccepted: number;
  invitesPurged: number;
  abandonedPurged: number;
  warned: number;
  errors: { associateId: string; error: string }[];
}

/** Work-history guard, shared by both rules. True = this is NOT a ghost. */
async function hasProtectedHistory(
  prisma: PrismaClient,
  associateId: string,
): Promise<boolean> {
  // Sequential cheap counts; each short-circuits the rest.
  const timeEntries = await prisma.timeEntry.count({ where: { associateId }, take: 1 });
  if (timeEntries > 0) return true;
  const payroll = await prisma.payrollItem.count({ where: { associateId }, take: 1 });
  if (payroll > 0) return true;
  const external = await prisma.externalPayment.count({ where: { associateId }, take: 1 });
  if (external > 0) return true;
  const shifts = await prisma.shift.count({
    where: { assignedAssociateId: associateId },
    take: 1,
  });
  if (shifts > 0) return true;
  const punches = await prisma.kioskPunch.count({ where: { associateId }, take: 1 });
  if (punches > 0) return true;
  const separations = await prisma.separation.count({ where: { associateId }, take: 1 });
  if (separations > 0) return true;
  const everBeyondDraft = await prisma.application.count({
    where: {
      associateId,
      OR: [{ status: { not: 'DRAFT' } }, { submittedAt: { not: null } }],
    },
    take: 1,
  });
  return everBeyondDraft > 0;
}

/**
 * Hard-delete one ghost: notifications, onboarding rows, login, associate,
 * document blobs. Caller has already verified the guards.
 */
async function purgeGhost(
  prisma: PrismaClient,
  ghost: {
    associateId: string;
    userId: string | null;
    email: string;
    firstName: string;
    lastName: string;
  },
  kind: 'invite_expired' | 'onboarding_abandoned',
  now: Date,
): Promise<void> {
  const docs = await prisma.documentRecord.findMany({
    where: { associateId: ghost.associateId },
    select: { s3Key: true },
  });
  const assoc = await prisma.associate.findUnique({
    where: { id: ghost.associateId },
    select: { photoS3Key: true },
  });
  const blobKeys = docs
    .map((d) => d.s3Key)
    .filter((k): k is string => k !== null);
  if (assoc?.photoS3Key) blobKeys.push(assoc.photoS3Key);

  await prisma.$transaction(
    async (tx) => {
      // Their notifications (invite emails etc.) go with them — a purge
      // should leave no addressed rows behind, unlike employee erasure
      // which keeps scrubbed rows for delivery accounting.
      await tx.notification.deleteMany({
        where: ghost.userId
          ? { OR: [{ recipientUserId: ghost.userId }, { recipientEmail: ghost.email }] }
          : { recipientEmail: ghost.email },
      });
      // Explicit deletes for the relations that RESTRICT associate
      // deletion. The guards make the payroll-side ones empty; onboarding
      // artifacts (background checks started pre-approval, uploaded
      // documents) are exactly what this purge exists to destroy.
      await tx.associateAssignment.deleteMany({ where: { associateId: ghost.associateId } });
      await tx.backgroundCheck.deleteMany({ where: { associateId: ghost.associateId } });
      await tx.drugTest.deleteMany({ where: { associateId: ghost.associateId } });
      await tx.documentRecord.deleteMany({ where: { associateId: ghost.associateId } });
      await tx.pendingPayrollDeduction.deleteMany({ where: { associateId: ghost.associateId } });
      await tx.application.deleteMany({ where: { associateId: ghost.associateId } });
      if (ghost.userId) {
        // Cascades invite/reset tokens, passkeys, push subs, prefs.
        await tx.user.delete({ where: { id: ghost.userId } });
      }
      // Cascades everything else (checklist artifacts, I-9/W-4 rows,
      // emergency contacts, kiosk PINs, availability, …).
      await tx.associate.delete({ where: { id: ghost.associateId } });
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  // Blob deletion is best-effort outside the transaction — the DB no
  // longer points at these files either way.
  const blobStore = getBlobStore();
  for (const key of blobKeys) {
    try {
      await blobStore.delete(key);
    } catch (err) {
      logger.warn(
        { err, associateId: ghost.associateId, key },
        'onboarding purge: blob delete failed (already gone?)',
      );
    }
  }

  // Permanent record of who was removed and why — the one place the name
  // survives. Awaited so a failed insert surfaces as a sweep error.
  await recordCriticalAudit(
    {
      actorUserId: null,
      action: 'onboarding.ghost_purged',
      entityType: 'Associate',
      entityId: ghost.associateId,
      metadata: {
        kind,
        name: `${ghost.firstName} ${ghost.lastName}`,
        email: ghost.email,
        purgedAt: now.toISOString(),
      } as Prisma.InputJsonValue,
    },
    'onboardingPurge.purgeGhost',
  );
}

export async function runOnboardingPurgeSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<PurgeSweepResult> {
  const result: PurgeSweepResult = {
    scannedInvited: 0,
    scannedAccepted: 0,
    invitesPurged: 0,
    abandonedPurged: 0,
    warned: 0,
    errors: [],
  };
  const purgedNames: string[] = [];
  const recentLinkCutoff = new Date(
    now.getTime() - RECENT_LINK_GUARD_HOURS * 60 * 60 * 1000,
  );

  /* ----- Rule 1: invited, never accepted, 3 days ------------------------- */
  const invited = await prisma.user.findMany({
    where: {
      status: 'INVITED',
      passwordHash: null,
      role: 'ASSOCIATE',
      deletedAt: null,
      associateId: { not: null },
      associate: {
        deletedAt: null,
        erasedAt: null,
        separatedAt: null,
        deactivatedAt: null,
        hireDate: null,
      },
      // Anyone we emailed a live link to in the last day is off-limits.
      NOT: { inviteTokens: { some: { createdAt: { gt: recentLinkCutoff } } } },
    },
    select: {
      id: true,
      createdAt: true,
      associateId: true,
      associate: { select: { firstName: true, lastName: true, email: true } },
      inviteTokens: {
        where: { mintedBySweep: false },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
    take: 200,
  });
  result.scannedInvited = invited.length;

  for (const user of invited) {
    const associateId = user.associateId!;
    try {
      const clock = user.inviteTokens[0]?.createdAt ?? user.createdAt;
      if (now.getTime() - clock.getTime() < INVITE_PURGE_AFTER_DAYS * DAY_MS) continue;
      if (await hasProtectedHistory(prisma, associateId)) continue;
      await purgeGhost(
        prisma,
        {
          associateId,
          userId: user.id,
          email: user.associate!.email,
          firstName: user.associate!.firstName,
          lastName: user.associate!.lastName,
        },
        'invite_expired',
        now,
      );
      result.invitesPurged += 1;
      purgedNames.push(
        `${user.associate!.firstName} ${user.associate!.lastName} (invite never accepted)`,
      );
    } catch (err) {
      result.errors.push({
        associateId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* ----- Rule 2: accepted, abandoned mid-onboarding, 10 idle days -------- */
  const accepted = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      role: 'ASSOCIATE',
      deletedAt: null,
      associateId: { not: null },
      associate: {
        deletedAt: null,
        erasedAt: null,
        separatedAt: null,
        deactivatedAt: null,
        hireDate: null,
        // At least one live draft — someone to purge — and no application
        // that ever advanced (submitted apps are in HR's court, not ours).
        applications: { some: { deletedAt: null, status: 'DRAFT', submittedAt: null } },
      },
      NOT: { inviteTokens: { some: { createdAt: { gt: recentLinkCutoff } } } },
    },
    select: {
      id: true,
      createdAt: true,
      associateId: true,
      associate: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          purgeWarnedAt: true,
          applications: {
            where: { deletedAt: null },
            select: {
              id: true,
              invitedAt: true,
              checklist: {
                select: { tasks: { select: { completedAt: true } } },
              },
            },
          },
          documents: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { createdAt: true },
          },
        },
      },
      inviteTokens: {
        where: { consumedAt: { not: null } },
        orderBy: { consumedAt: 'desc' },
        take: 1,
        select: { consumedAt: true },
      },
    },
    take: 200,
  });
  result.scannedAccepted = accepted.length;

  for (const user of accepted) {
    const associateId = user.associateId!;
    try {
      const a = user.associate!;
      // Idle clock = the newest sign of life anywhere in their onboarding.
      let lastActivityMs = user.createdAt.getTime();
      const consumed = user.inviteTokens[0]?.consumedAt;
      if (consumed) lastActivityMs = Math.max(lastActivityMs, consumed.getTime());
      const latestDoc = a.documents[0]?.createdAt;
      if (latestDoc) lastActivityMs = Math.max(lastActivityMs, latestDoc.getTime());
      for (const app of a.applications) {
        lastActivityMs = Math.max(lastActivityMs, app.invitedAt.getTime());
        for (const t of app.checklist?.tasks ?? []) {
          if (t.completedAt) lastActivityMs = Math.max(lastActivityMs, t.completedAt.getTime());
        }
      }
      const idleMs = now.getTime() - lastActivityMs;
      if (idleMs < FINAL_NOTICE_AFTER_DAYS * DAY_MS) continue;
      if (await hasProtectedHistory(prisma, associateId)) continue;

      // A warning is only "standing" if it postdates the last activity —
      // activity after a warning re-arms a fresh one.
      const warnedAt =
        a.purgeWarnedAt && a.purgeWarnedAt.getTime() > lastActivityMs
          ? a.purgeWarnedAt
          : null;

      if (!warnedAt) {
        const daysLeft = Math.max(
          2,
          IDLE_PURGE_AFTER_DAYS - Math.floor(idleMs / DAY_MS),
        );
        await notifyUser(user.id, {
          subject: `Final notice: your onboarding will be removed in ${daysLeft} days`,
          body:
            `Hi ${a.firstName},\n\n` +
            `Your onboarding has been inactive for ${Math.floor(idleMs / DAY_MS)} days. ` +
            `If nothing moves in the next ${daysLeft} days, your application and everything ` +
            `you've uploaded will be permanently removed, and you would need a fresh ` +
            `invitation to start again.\n\n` +
            `Pick up where you left off: ${env.APP_BASE_URL}/onboarding`,
          category: 'onboarding.purge_warning',
          linkUrl: '/onboarding',
        });
        await prisma.associate.update({
          where: { id: associateId },
          data: { purgeWarnedAt: now },
        });
        result.warned += 1;
        continue;
      }

      const warningAgeMs = now.getTime() - warnedAt.getTime();
      if (
        idleMs < IDLE_PURGE_AFTER_DAYS * DAY_MS ||
        warningAgeMs < FINAL_NOTICE_MIN_GAP_HOURS * 60 * 60 * 1000
      ) {
        continue;
      }

      await purgeGhost(
        prisma,
        {
          associateId,
          userId: user.id,
          email: a.email,
          firstName: a.firstName,
          lastName: a.lastName,
        },
        'onboarding_abandoned',
        now,
      );
      result.abandonedPurged += 1;
      purgedNames.push(`${a.firstName} ${a.lastName} (onboarding abandoned)`);
    } catch (err) {
      result.errors.push({
        associateId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (purgedNames.length > 0) {
    const n = purgedNames.length;
    await notifyAllAdmins({
      subject: `Onboarding cleanup: ${n} stale record${n === 1 ? '' : 's'} removed`,
      body:
        `The automatic onboarding cleanup removed ${n} record${n === 1 ? '' : 's'} ` +
        `(unaccepted invites after ${INVITE_PURGE_AFTER_DAYS} days, abandoned ` +
        `onboardings after ${IDLE_PURGE_AFTER_DAYS} idle days):\n\n` +
        purgedNames.map((p) => `  • ${p}`).join('\n') +
        `\n\nEach removal is recorded in the audit log. A fresh invitation recreates ` +
        `anyone who comes back.`,
      category: 'onboarding',
      emailRoles: ADMIN_EMAIL_HR_ONLY,
    });
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startOnboardingPurgeCron(): void {
  if (timer) return;
  const seconds = env.ONBOARDING_PURGE_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void runOnboardingPurgeSweep().catch((err) => {
      console.error('[alto-people/api] onboarding purge sweep failed:', err);
    });
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] onboarding purge cron armed (every ${seconds}s; invites ${INVITE_PURGE_AFTER_DAYS}d, abandoned ${IDLE_PURGE_AFTER_DAYS}d idle, notice at ${FINAL_NOTICE_AFTER_DAYS}d)`,
  );
}

export function stopOnboardingPurgeCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
