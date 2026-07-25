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
 * are intact but unreadable; the fix is the associate re-entering their
 * SSN on the (already resubmittable) W-4 onboarding step AND uploading a
 * photo of their Social Security card so payroll holds both the number
 * and the document image.
 *
 * This router lets payroll admins see who is still outstanding, email
 * them a request, and watch the list drain. An associate is outstanding
 * while their number is unreadable — and, once we've contacted them,
 * also while no SSN-card image is on file. The number half is derived
 * straight from the blob (no bookkeeping to forget); the card half uses
 * the campaign's own send history as the "in the campaign" marker, since
 * a readable blob alone can't tell us the associate was ever affected.
 */
export const w4RecollectionRouter = Router();

export const W4_RECOLLECTION_CATEGORY = 'w4.ssn_recollection';

interface CampaignRow {
  submittedAt: Date | null;
  /** Stored SSN blob does not decrypt under the current key. */
  needsNumber: boolean;
  /** A non-deleted SSN_CARD document image is on file. */
  hasSsnCard: boolean;
  /** SSN card OR I-9 supporting image — enough for an admin to re-key from. */
  hasRekeyDoc: boolean;
  associate: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    hireDate: Date | null;
    ssnLast4: string | null;
    user: { id: string; status: string } | null;
    applications: { id: string }[];
  };
}

/**
 * Every W-4 row with a stored SSN, annotated with what the campaign still
 * needs from it. ~200 rows org-wide, so decrypt-testing all of them per
 * request is a few milliseconds — the blob itself is the source of truth,
 * which beats maintaining a parallel "affected" flag that could drift.
 */
async function loadCampaignRows(): Promise<CampaignRow[]> {
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
          documents: {
            where: { kind: { in: ['SSN_CARD', 'I9_SUPPORTING'] }, deletedAt: null },
            select: { id: true, kind: true },
          },
        },
      },
    },
  });
  return rows.map((r) => {
    const { documents, ...associate } = r.associate;
    return {
      submittedAt: r.signedAt,
      needsNumber: tryDecryptString(r.ssnEncrypted!) === null,
      hasSsnCard: documents.some((d) => d.kind === 'SSN_CARD'),
      hasRekeyDoc: documents.length > 0,
      associate,
    };
  });
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

interface Campaign {
  /** Rows the campaign still needs something from, oldest submission first. */
  outstanding: CampaignRow[];
  history: Map<string, { count: number; lastSentAt: Date | null }>;
}

async function loadCampaign(): Promise<Campaign> {
  const [rows, history] = await Promise.all([loadCampaignRows(), loadSendHistory()]);
  const outstanding = rows.filter((r) => {
    const notified = r.associate.user ? history.has(r.associate.user.id) : false;
    // Card-only rows are held open only for associates we've contacted —
    // otherwise every pre-campaign associate without a card image would
    // flood the roster.
    return r.needsNumber || (notified && !r.hasSsnCard);
  });
  return { outstanding, history };
}

/** How many previously-notified associates have since fully resolved. */
async function countResolved(outstandingIds: Set<string>): Promise<number> {
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
  return users.filter((u) => u.associateId && !outstandingIds.has(u.associateId)).length;
}

// Light payload for the admin-dashboard action card — counts only.
w4RecollectionRouter.get('/summary', async (_req, res) => {
  const { outstanding, history } = await loadCampaign();
  const outstandingIds = new Set(outstanding.map((r) => r.associate.id));
  const notified = outstanding.filter(
    (r) => r.associate.user && history.has(r.associate.user.id),
  ).length;
  res.json({
    outstanding: outstanding.length,
    notified,
    resolved: await countResolved(outstandingIds),
  });
});

w4RecollectionRouter.get('/', async (_req, res) => {
  const { outstanding, history } = await loadCampaign();
  const outstandingIds = new Set(outstanding.map((r) => r.associate.id));

  const rows = outstanding.map((r) => {
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
      /** The stored number still doesn't decrypt — must be re-entered. */
      needsNumber: r.needsNumber,
      /** No SSN card image on file — must be uploaded. */
      needsCard: !r.hasSsnCard,
      /** True when an SSN card / I-9 doc image is on file to re-key from. */
      hasSsnDocument: r.hasRekeyDoc,
      emailCount: sends?.count ?? 0,
      lastEmailedAt: sends?.lastSentAt ? sends.lastSentAt.toISOString() : null,
    };
  });

  res.json({
    rows,
    summary: {
      outstanding: rows.length,
      notified: rows.filter((r) => r.emailCount > 0).length,
      resolved: await countResolved(outstandingIds),
    },
  });
});

const BulkEmailSchema = z.object({
  associateIds: z.array(z.string().uuid()).min(1).max(1000),
});

export type W4RecollectionSkipReason = 'not_affected' | 'no_account' | 'no_application';

w4RecollectionRouter.post('/email', async (req, res) => {
  const { associateIds } = BulkEmailSchema.parse(req.body);
  const { outstanding } = await loadCampaign();
  const byId = new Map(outstanding.map((r) => [r.associate.id, r]));

  const skipped: { associateId: string; reason: W4RecollectionSkipReason }[] = [];
  const queued: string[] = [];

  for (const id of new Set(associateIds)) {
    const row = byId.get(id);
    if (!row) {
      // Already fully resolved (or never affected) — nothing to ask for.
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
      needsNumber: row.needsNumber,
      needsCard: !row.hasSsnCard,
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
