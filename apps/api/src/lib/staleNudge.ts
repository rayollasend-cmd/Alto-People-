import type { Request } from 'express';
import type { SessionUser } from '../types/express.js';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { computePercent } from './checklist.js';
import {
  deliverNudge,
  fetchInFlightApplications,
  isStaleApplication,
  staleNudgeContent,
} from '../routes/onboarding.js';

/**
 * Automatic stale-application nudge — the cron twin of the manual
 * POST /onboarding/applications/nudge-stale button.
 *
 * The 48h invite reminder only chases people who never accepted, and the
 * ghost purge only deletes zero-activity drafts. Someone who finished 4 of
 * 7 tasks and stalled past the 7-day staleness rule was chased by nobody
 * unless HR remembered the button. This sweep sends them the exact same
 * personalized nudge on a timer, org-wide.
 *
 * Anti-spam (automatic runs ONLY — a human clicking the button is the
 * judgment call and stays uncapped): per recipient, no nudge within
 * STALE_NUDGE_COOLDOWN_HOURS of the last onboarding.nudge row (manual
 * ones count — HR just reached out), and at most STALE_NUDGE_MAX_AUTO
 * automatic nudges ever (rows with senderUserId null). Only rows that
 * actually sent count, so a provider failure doesn't burn a nudge.
 *
 * The route/sweep helpers live in routes/onboarding.ts (shared with the
 * stats tile so the staleness rule can never diverge); the import cycle
 * this creates is benign — both sides only call at request/sweep time.
 */

export const STALE_NUDGE_COOLDOWN_HOURS = 72;
export const STALE_NUDGE_MAX_AUTO = 3;

export interface StaleNudgeSweepResult {
  nudged: number;
  skipped: number;
}

export async function runStaleNudgeSweep(
  opts: {
    /** Tenant scope for the fetch; null/omitted (the cron) is org-wide. */
    scope?: SessionUser | null;
    /** HR user behind a manual run; null/omitted = automatic, which
     *  enforces the cooldown + lifetime cap. */
    actor?: { userId: string; req: Request } | null;
    now?: Date;
  } = {},
): Promise<StaleNudgeSweepResult> {
  const scope = opts.scope ?? null;
  const actor = opts.actor ?? null;
  const now = opts.now ?? new Date();

  const rows = await fetchInFlightApplications(scope);
  const stale = rows.filter((row) =>
    isStaleApplication(
      row.invitedAt,
      computePercent(row.checklist?.tasks ?? []),
      now.getTime(),
    ),
  );

  // One user fetch for the whole set (same batching as bulk-resend).
  const userRows = await prisma.user.findMany({
    where: {
      associateId: { in: [...new Set(stale.map((r) => r.associateId))] },
    },
  });
  const userByAssociateId = new Map<string, (typeof userRows)[number]>();
  for (const u of userRows) {
    if (u.associateId && !userByAssociateId.has(u.associateId)) {
      userByAssociateId.set(u.associateId, u);
    }
  }

  // Prior-nudge history per recipient, fetched once (automatic runs only).
  const priorByUser = new Map<
    string,
    { autoCount: number; newestSentAtMs: number }
  >();
  if (!actor && userRows.length > 0) {
    const prior = await prisma.notification.findMany({
      where: {
        category: 'onboarding.nudge',
        recipientUserId: { in: userRows.map((u) => u.id) },
        sentAt: { not: null },
      },
      select: { recipientUserId: true, senderUserId: true, sentAt: true },
    });
    for (const n of prior) {
      if (!n.recipientUserId || !n.sentAt) continue;
      const entry = priorByUser.get(n.recipientUserId) ?? {
        autoCount: 0,
        newestSentAtMs: 0,
      };
      if (n.senderUserId === null) entry.autoCount += 1;
      entry.newestSentAtMs = Math.max(entry.newestSentAtMs, n.sentAt.getTime());
      priorByUser.set(n.recipientUserId, entry);
    }
  }

  const cooldownMs = STALE_NUDGE_COOLDOWN_HOURS * 60 * 60 * 1000;
  let nudged = 0;
  let skipped = 0;
  // Serial sends — the email sender already spaces provider calls, and
  // the stale set is bounded by the in-flight fetch's 500-row cap.
  for (const row of stale) {
    const user = userByAssociateId.get(row.associateId);
    if (!user || !user.email) {
      skipped++;
      continue;
    }
    if (!actor) {
      const prior = priorByUser.get(user.id);
      if (
        prior &&
        (prior.autoCount >= STALE_NUDGE_MAX_AUTO ||
          now.getTime() - prior.newestSentAtMs < cooldownMs)
      ) {
        skipped++;
        continue;
      }
    }
    const tasks = row.checklist?.tasks ?? [];
    const blocked = [...tasks]
      .sort((a, b) => a.order - b.order)
      .find((t) => t.status !== 'DONE' && t.status !== 'SKIPPED');
    const { subject, body } = staleNudgeContent(
      row.associate.firstName,
      computePercent(tasks),
      blocked?.title ?? null,
    );
    const { emailSent } = await deliverNudge(
      actor,
      row,
      { id: user.id, email: user.email },
      subject,
      body,
      actor ? { bulk: true } : { bulk: true, automatic: true },
    );
    if (emailSent) nudged++;
    else skipped++;
  }

  return { nudged, skipped };
}

let timer: NodeJS.Timeout | null = null;

export function startStaleNudgeCron(): void {
  if (timer) return;
  const seconds = env.STALE_NUDGE_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void runStaleNudgeSweep().catch((err) => {
      console.error('[alto-people/api] stale nudge sweep failed:', err);
    });
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] stale nudge cron armed (every ${seconds}s; cooldown ${STALE_NUDGE_COOLDOWN_HOURS}h, max ${STALE_NUDGE_MAX_AUTO} automatic nudges per recipient)`,
  );
}

export function stopStaleNudgeCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
