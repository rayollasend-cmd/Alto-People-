import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { send } from './notifications.js';
import { ADMIN_EMAIL_HIRING, notifyAllAdmins, notifyUser } from './notify.js';
import { generateInviteToken } from './inviteToken.js';
import { onboardingReminderTemplate, inviteTemplate } from './emailTemplates.js';

/**
 * Phase 17 — invite reminder sweep.
 *
 * An associate who got an invitation but hasn't accepted it yet is one of
 * the most common drop-off points in onboarding. After 48h we send them
 * one reminder email containing a fresh magic link.
 *
 * Token rotation: we never stored the raw token from the original invite,
 * only the sha256 hash. So the reminder generates a brand new token,
 * supersedes any open older tokens for the same user (their consumedAt
 * gets set to now), and the email body links to the new one. This keeps
 * single-use semantics intact — the original email's link is now dead.
 *
 * Idempotency: once a reminder fires for a user we mark the *new* token's
 * `reminderSentAt`. Subsequent sweeps skip it because of that marker AND
 * because the new token's createdAt is younger than the 48h cutoff.
 * HR-triggered resend (in routes/onboarding.ts) creates yet another fresh
 * token and is exempt from the 48h gate.
 *
 * The cron itself is a setInterval gated by env.INVITE_REMINDER_INTERVAL_SECONDS;
 * it's started/stopped from src/index.ts. Tests call `runInviteReminderSweep`
 * directly without arming the timer.
 */

export const INVITE_REMINDER_AFTER_HOURS = 48;

export interface SweepResult {
  scanned: number;
  reminded: number;
  errors: { userId: string; error: string }[];
}

export async function runInviteReminderSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date()
): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - INVITE_REMINDER_AFTER_HOURS * 60 * 60 * 1000);

  const candidates = await prisma.inviteToken.findMany({
    where: {
      consumedAt: null,
      reminderSentAt: null,
      // No expiresAt filter — an EXPIRED invite is precisely the case that
      // needs a reminder, because the sweep re-mints a fresh token anyway.
      // The old `expiresAt > now` filter made lapsed invites permanently
      // invisible: the people who most needed a new link never got one.
      createdAt: { lt: cutoff },
      user: { status: 'INVITED', passwordHash: null },
    },
    include: {
      user: {
        include: {
          associate: {
            include: {
              applications: {
                where: { deletedAt: null },
                include: { client: { select: { name: true } } },
                orderBy: { invitedAt: 'desc' },
                take: 1,
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  const errors: { userId: string; error: string }[] = [];
  let reminded = 0;

  for (const token of candidates) {
    try {
      await sendReminderForUser(prisma, token.userId, { now });
      reminded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ userId: token.userId, error: msg });
    }
  }

  return { scanned: candidates.length, reminded, errors };
}

/**
 * Rotate a fresh invite token for `userId`, kill any open older tokens,
 * send a reminder/resend email with the new link, and record both the
 * Notification row and the new token's reminderSentAt marker. Used by the
 * cron sweep AND by the HR-triggered `/resend-invite` admin endpoint.
 *
 * Throws if the user doesn't exist or isn't currently INVITED — the
 * caller decides how to handle that (sweep records to errors[], the HTTP
 * route returns 4xx).
 */
export async function sendReminderForUser(
  prisma: PrismaClient,
  userId: string,
  opts: { now?: Date; reason?: 'sweep' | 'manual' } = {}
): Promise<{ tokenId: string; rawToken: string; externalRef: string | null }> {
  const now = opts.now ?? new Date();
  const reason = opts.reason ?? 'sweep';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      associate: {
        include: {
          applications: {
            where: { deletedAt: null },
            include: { client: { select: { name: true } } },
            orderBy: { invitedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });
  if (!user) throw new Error('user_not_found');
  if (user.status !== 'INVITED' || user.passwordHash) {
    throw new Error('user_not_invitable');
  }

  const fresh = generateInviteToken();
  const expiresAt = new Date(now.getTime() + env.INVITE_TOKEN_TTL_SECONDS * 1000);

  // Rotate atomically: kill open tokens, create new token, mark new token
  // as "reminded" so the sweep doesn't pick this person up again.
  const newToken = await prisma.$transaction(
    async (tx) => {
      await tx.inviteToken.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      });
      return tx.inviteToken.create({
        data: {
          tokenHash: fresh.hash,
          userId,
          expiresAt,
          reminderSentAt: now,
          // The purge sweep's 3-day clock runs from the newest HUMAN-caused
          // token; an automatic 48h reminder must not restart it.
          mintedBySweep: reason === 'sweep',
        },
      });
    },
    { timeout: 30_000, maxWait: 10_000 }
  );

  const firstName = user.associate?.firstName ?? 'there';
  const clientName = user.associate?.applications?.[0]?.client?.name ?? 'your employer';
  const acceptUrl = `${env.APP_BASE_URL}/accept-invite/${fresh.raw}`;
  // Manual resends are treated as a fresh invite (HR clicked Resend); the
  // 48h cron path is the actual "you forgot" reminder template.
  const tpl =
    reason === 'manual'
      ? inviteTemplate({
          firstName,
          clientName,
          magicLink: acceptUrl,
          linkExpiresAt: expiresAt.toISOString().slice(0, 10),
        })
      : onboardingReminderTemplate({
          firstName,
          clientName,
          percentComplete: 0,
          hireDate: user.associate?.hireDate ? user.associate.hireDate.toISOString().slice(0, 10) : null,
          magicLink: acceptUrl,
        });
  const subject = tpl.subject;
  const body = tpl.text;

  let externalRef: string | null = null;
  let failureReason: string | null = null;
  try {
    const r = await send({
      channel: 'EMAIL',
      recipient: { userId: user.id, phone: null, email: user.email },
      subject,
      body,
      html: tpl.html,
    });
    externalRef = r.externalRef;
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err);
  }

  await prisma.notification.create({
    data: {
      channel: 'EMAIL',
      status: failureReason ? 'FAILED' : 'SENT',
      recipientUserId: user.id,
      recipientEmail: user.email,
      subject,
      body,
      category: 'onboarding.invite_reminder',
      externalRef,
      failureReason,
      sentAt: failureReason ? null : now,
      senderUserId: null,
    },
  });

  if (failureReason) {
    throw new Error(failureReason);
  }

  return { tokenId: newToken.id, rawToken: fresh.raw, externalRef };
}

/* ===== Progress reminders ================================================ */

/** Days of task inactivity before an accepted-but-stalled associate is
 *  nagged about their outstanding tasks. */
export const PROGRESS_REMINDER_AFTER_DAYS = 3;

export interface ProgressSweepResult {
  scanned: number;
  reminded: number;
  escalated: number;
  errors: { applicationId: string; error: string }[];
}

/**
 * The invite sweep only covers people who never logged in. This one covers
 * the bigger population: associates who ACCEPTED and then stalled mid-
 * checklist. Anyone on an open DRAFT application with no task completed in
 * PROGRESS_REMINDER_AFTER_DAYS days gets an email naming the outstanding
 * tasks (with their real progress); the 2nd+ reminder also escalates to
 * HR so a human follows up.
 */
export async function runProgressReminderSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date()
): Promise<ProgressSweepResult> {
  const idleCutoff = new Date(
    now.getTime() - PROGRESS_REMINDER_AFTER_DAYS * 24 * 60 * 60 * 1000,
  );
  const apps = await prisma.application.findMany({
    where: {
      deletedAt: null,
      status: 'DRAFT',
      submittedAt: null,
      OR: [
        { progressRemindedAt: null },
        { progressRemindedAt: { lt: idleCutoff } },
      ],
    },
    include: {
      associate: {
        select: {
          firstName: true,
          user: { select: { id: true, status: true } },
        },
      },
      client: { select: { name: true } },
      checklist: { include: { tasks: true } },
    },
    orderBy: { invitedAt: 'asc' },
    take: 200,
  });

  const errors: { applicationId: string; error: string }[] = [];
  let reminded = 0;
  let escalated = 0;

  for (const app of apps) {
    try {
      const user = app.associate.user;
      // Not accepted yet → the invite sweep's job, not ours.
      if (!user || user.status !== 'ACTIVE') continue;
      const tasks = app.checklist?.tasks ?? [];
      if (tasks.length === 0) continue;
      const open = tasks.filter(
        (t) => t.status !== 'DONE' && t.status !== 'SKIPPED',
      );
      if (open.length === 0) continue;
      // "Idle" = nothing completed recently (and the invite itself is old).
      const lastActivityMs = Math.max(
        app.invitedAt.getTime(),
        ...tasks
          .filter((t) => t.completedAt)
          .map((t) => t.completedAt!.getTime()),
      );
      if (lastActivityMs > idleCutoff.getTime()) continue;

      const done = tasks.length - open.length;
      const percent = Math.round((done / tasks.length) * 100);
      const idleDays = Math.floor(
        (now.getTime() - lastActivityMs) / (24 * 60 * 60 * 1000),
      );
      const taskLines = open
        .slice(0, 8)
        .map((t) => `  • ${t.title}`)
        .join('\n');
      const linkPath = `/onboarding/me/${app.id}`;
      void notifyUser(user.id, {
        subject: `[Reminder] ${open.length} onboarding task${open.length === 1 ? '' : 's'} still open — ${app.client.name}`,
        body:
          `Hi ${app.associate.firstName},\n\n` +
          `Your onboarding for ${app.client.name} is ${percent}% complete, ` +
          `but nothing has moved in ${idleDays} day${idleDays === 1 ? '' : 's'}. ` +
          `Still outstanding:\n\n${taskLines}\n\n` +
          `Pick up where you left off: ${env.APP_BASE_URL}${linkPath}`,
        category: 'onboarding.progress_reminder',
        linkUrl: linkPath,
      });

      const newCount = app.progressRemindCount + 1;
      await prisma.application.update({
        where: { id: app.id },
        data: { progressRemindedAt: now, progressRemindCount: newCount },
      });
      reminded++;

      // Second-and-later nags escalate to HR — the associate has now been
      // reminded before and is still stuck.
      if (newCount >= 2) {
        void notifyAllAdmins({
          subject: `Onboarding stalled: ${app.associate.firstName} at ${percent}% (${idleDays}d idle)`,
          body:
            `${app.associate.firstName}'s onboarding for ${app.client.name} has been idle ` +
            `${idleDays} days at ${percent}% despite ${newCount} reminders. ` +
            `Outstanding: ${open.map((t) => t.title).join(', ')}. ` +
            `Open it: ${env.APP_BASE_URL}/onboarding/applications/${app.id}`,
          category: 'onboarding',
          emailRoles: ADMIN_EMAIL_HIRING,
        });
        escalated++;
      }
    } catch (err) {
      errors.push({
        applicationId: app.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: apps.length, reminded, escalated, errors };
}

let timer: NodeJS.Timeout | null = null;

export function startInviteReminderCron(): void {
  if (timer) return;
  const seconds = env.INVITE_REMINDER_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const runBoth = () => {
    void runInviteReminderSweep().catch((err) => {
      console.error('[alto-people/api] invite reminder sweep failed:', err);
    });
    void runProgressReminderSweep().catch((err) => {
      console.error('[alto-people/api] progress reminder sweep failed:', err);
    });
  };
  runBoth();
  timer = setInterval(runBoth, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] onboarding reminder cron armed (every ${seconds}s; invite threshold ${INVITE_REMINDER_AFTER_HOURS}h, progress threshold ${PROGRESS_REMINDER_AFTER_DAYS}d)`
  );
}

export function stopInviteReminderCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
