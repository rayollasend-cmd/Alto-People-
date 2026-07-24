import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { tryDecryptString } from '../lib/crypto.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyUser } from '../lib/notify.js';
import { w4SsnRecollectionTemplate } from '../lib/emailTemplates.js';

/**
 * W-4 SSN re-collection campaign — remediation surface for the 2026-06-11
 * key-rotation incident. W4Submission rows encrypted under the lost key
 * are intact but unreadable; the only fix is the associate re-entering
 * their SSN on the (already resubmittable) W-4 onboarding step.
 *
 * This router lets payroll admins see who is still outstanding, email
 * them a re-entry request, and watch the list drain as resubmissions
 * land — an associate drops off the moment their blob decrypts again,
 * with no explicit "done" bookkeeping to forget.
 */
export const w4RecollectionRouter = Router();

export const W4_RECOLLECTION_CATEGORY = 'w4.ssn_recollection';

interface AffectedRow {
  submittedAt: Date | null;
  associate: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    hireDate: Date | null;
    ssnLast4: string | null;
    user: { id: string; status: string } | null;
    applications: { id: string }[];
    documents: { id: string }[];
  };
}

/**
 * Every associate whose stored W-4 SSN does not decrypt under the current
 * key. ~200 rows org-wide, so decrypt-testing all of them per request is
 * a few milliseconds — the blob itself is the source of truth, which
 * beats maintaining a parallel "affected" flag that could drift.
 */
async function loadAffected(): Promise<AffectedRow[]> {
  const rows = await prisma.w4Submission.findMany({
    where: { ssnEncrypted: { not: null }, associate: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: {
      signedAt: true,
      ssnEncrypted: true,
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          hireDate: true,
          ssnLast4: true,
          user: { select: { id: true, status: true } },
          applications: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true },
          },
          // An SSN card or I-9 supporting image on file means an admin can
          // re-key the number from the document without waiting on the
          // associate — surfaced as a per-row shortcut in the roster.
          documents: {
            where: { kind: { in: ['SSN_CARD', 'I9_SUPPORTING'] }, deletedAt: null },
            select: { id: true },
          },
        },
      },
    },
  });
  return rows
    .filter((r) => tryDecryptString(r.ssnEncrypted!) === null)
    .map((r) => ({ submittedAt: r.signedAt, associate: r.associate }));
}

/** Per-user send history for the campaign category: count + latest. */
async function loadSendHistory(): Promise<
  Map<string, { count: number; lastSentAt: Date | null }>
> {
  const notifs = await prisma.notification.findMany({
    where: {
      category: W4_RECOLLECTION_CATEGORY,
      channel: 'EMAIL',
      status: 'SENT',
      recipientUserId: { not: null },
    },
    select: { recipientUserId: true, sentAt: true },
  });
  const byUser = new Map<string, { count: number; lastSentAt: Date | null }>();
  for (const n of notifs) {
    const entry = byUser.get(n.recipientUserId!) ?? { count: 0, lastSentAt: null };
    entry.count += 1;
    if (n.sentAt && (!entry.lastSentAt || n.sentAt > entry.lastSentAt)) {
      entry.lastSentAt = n.sentAt;
    }
    byUser.set(n.recipientUserId!, entry);
  }
  return byUser;
}

/** How many previously-notified associates have since resubmitted. */
async function countResolved(affectedIds: Set<string>): Promise<number> {
  const notifiedUserIds = await prisma.notification.findMany({
    where: {
      category: W4_RECOLLECTION_CATEGORY,
      channel: 'EMAIL',
      status: 'SENT',
      recipientUserId: { not: null },
    },
    distinct: ['recipientUserId'],
    select: { recipientUserId: true },
  });
  if (notifiedUserIds.length === 0) return 0;
  const users = await prisma.user.findMany({
    where: { id: { in: notifiedUserIds.map((n) => n.recipientUserId!) } },
    select: { associateId: true },
  });
  return users.filter((u) => u.associateId && !affectedIds.has(u.associateId)).length;
}

// Light payload for the admin-dashboard action card — counts only.
w4RecollectionRouter.get('/summary', async (_req, res) => {
  const affected = await loadAffected();
  const affectedIds = new Set(affected.map((r) => r.associate.id));
  const history = await loadSendHistory();
  const notified = affected.filter(
    (r) => r.associate.user && history.has(r.associate.user.id),
  ).length;
  res.json({
    outstanding: affected.length,
    notified,
    resolved: await countResolved(affectedIds),
  });
});

w4RecollectionRouter.get('/', async (_req, res) => {
  const affected = await loadAffected();
  const affectedIds = new Set(affected.map((r) => r.associate.id));
  const history = await loadSendHistory();

  const rows = affected.map((r) => {
    const a = r.associate;
    const hasAccount = a.user?.status === 'ACTIVE';
    const sends = a.user ? history.get(a.user.id) : undefined;
    return {
      associateId: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      email: a.email,
      hasAccount,
      applicationId: a.applications[0]?.id ?? null,
      hireDate: a.hireDate ? a.hireDate.toISOString() : null,
      w4SubmittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      ssnLast4: a.ssnLast4,
      /** True when an SSN card / I-9 doc image is on file to re-key from. */
      hasSsnDocument: a.documents.length > 0,
      emailCount: sends?.count ?? 0,
      lastEmailedAt: sends?.lastSentAt ? sends.lastSentAt.toISOString() : null,
    };
  });

  res.json({
    rows,
    summary: {
      outstanding: rows.length,
      notified: rows.filter((r) => r.emailCount > 0).length,
      resolved: await countResolved(affectedIds),
    },
  });
});

const BulkEmailSchema = z.object({
  associateIds: z.array(z.string().uuid()).min(1).max(1000),
});

export type W4RecollectionSkipReason = 'not_affected' | 'no_account' | 'no_application';

w4RecollectionRouter.post('/email', async (req, res) => {
  const { associateIds } = BulkEmailSchema.parse(req.body);
  const affected = await loadAffected();
  const byId = new Map(affected.map((r) => [r.associate.id, r]));

  const skipped: { associateId: string; reason: W4RecollectionSkipReason }[] = [];
  const queued: string[] = [];

  for (const id of new Set(associateIds)) {
    const row = byId.get(id);
    if (!row) {
      // Already resubmitted (or never affected) — nothing to ask for.
      skipped.push({ associateId: id, reason: 'not_affected' });
      continue;
    }
    const a = row.associate;
    if (!a.user || a.user.status !== 'ACTIVE') {
      // No login → they couldn't reach the W-4 step anyway. The roster
      // flags these so the admin can re-invite them first.
      skipped.push({ associateId: id, reason: 'no_account' });
      continue;
    }
    const application = a.applications[0];
    if (!application) {
      skipped.push({ associateId: id, reason: 'no_application' });
      continue;
    }
    const taskPath = `/onboarding/me/${application.id}/tasks/w4`;
    const tpl = w4SsnRecollectionTemplate({
      firstName: a.firstName,
      taskUrl: `${env.APP_BASE_URL}${taskPath}`,
    });
    // Bell + email + push in one call; each email lands a Notification row
    // under this category, which is what the roster's "last emailed" and
    // the resolved counter read back.
    void notifyUser(a.user.id, {
      subject: tpl.subject,
      body: tpl.text,
      html: tpl.html,
      category: W4_RECOLLECTION_CATEGORY,
      linkUrl: taskPath,
    });
    queued.push(id);
  }

  if (queued.length === 0) {
    throw new HttpError(
      400,
      'nothing_to_send',
      'None of the selected associates can be emailed — they have already resubmitted, or have no active account to sign in with.',
    );
  }

  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'w4.recollection_emailed',
      entityType: 'Associate',
      entityId: queued[0]!,
      metadata: {
        count: queued.length,
        skipped: skipped.length,
        associateIds: queued,
      },
    },
    'w4.recollection_emailed',
  );

  res.json({ queued: queued.length, skipped });
});
