import type { CandidateStage } from '@prisma/client';
import { prisma } from '../db.js';
import { enqueueAudit } from './audit.js';
import { recordCandidateEvent } from './candidateEvents.js';
import { env } from '../config/env.js';
import { expireStaleInvites } from './onboardingUndo.js';

/**
 * Candidates who have gone quiet close on their own.
 *
 * The pipeline never let go of anyone: a candidate who stopped answering
 * stayed in Applied or Screening forever, and the recruiter's board and
 * "gone quiet" list grew until the people worth calling were lost in it.
 *
 * Quiet means nothing has happened for QUIET_AFTER_DAYS — no stage move,
 * note, interview, offer or client answer on their timeline — AND nothing
 * is pending on anyone: no interview still to come, no offer drafted,
 * held, out or signed, no client still deciding. Such a candidate is
 * moved to Withdrawn, "No response", on their timeline with no one's name
 * on it. It is an ordinary stage move: reopening is moving them back.
 *
 * The recruiter sees who is CLOSING_SOON_DAYS from closing on their
 * dashboard first, so nobody closes without warning.
 */

export const QUIET_AFTER_DAYS = 30;
export const CLOSING_SOON_DAYS = 5;
export const AUTO_CLOSE_REASON = `No response for ${QUIET_AFTER_DAYS} days — closed automatically`;

const DAY = 86_400_000;
const OPEN: CandidateStage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];

export interface QuietCandidate {
  id: string;
  firstName: string;
  lastName: string;
  position: string | null;
  stage: CandidateStage;
  /** The last thing that happened to them. */
  lastActivity: Date;
  /** When they close if nothing else happens. */
  closesAt: Date;
}

/**
 * Open-stage candidates whose last activity is before `before` (and, when
 * given, on or after `after`), with nothing pending. Oldest first.
 */
export async function quietCandidates(opts: { now: Date; before: Date; after?: Date; take?: number }): Promise<QuietCandidate[]> {
  const rows = await prisma.candidate.findMany({
    // A stage change is activity, so anyone who moved since `before` is
    // out already; the timeline decides for the rest.
    where: { deletedAt: null, stage: { in: OPEN }, stageChangedAt: { lt: opts.before } },
    orderBy: { stageChangedAt: 'asc' },
    take: opts.take ?? 1000,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      position: true,
      stage: true,
      stageChangedAt: true,
      events: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
      interviews: { where: { scheduledFor: { gt: opts.now } }, take: 1, select: { id: true } },
      offers: { where: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'SENT', 'ACCEPTED'] } }, take: 1, select: { id: true } },
      submittals: { where: { status: 'PENDING' }, take: 1, select: { id: true } },
    },
  });
  const out: QuietCandidate[] = [];
  for (const c of rows) {
    if (c.interviews.length || c.offers.length || c.submittals.length) continue;
    const last = c.events[0] && c.events[0].createdAt > c.stageChangedAt ? c.events[0].createdAt : c.stageChangedAt;
    if (last >= opts.before) continue;
    if (opts.after && last < opts.after) continue;
    out.push({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      position: c.position,
      stage: c.stage,
      lastActivity: last,
      closesAt: new Date(last.getTime() + QUIET_AFTER_DAYS * DAY),
    });
  }
  return out;
}

/** Who closes within CLOSING_SOON_DAYS — the recruiter's warning. */
export function closingSoon(now: Date, take = 1000): Promise<QuietCandidate[]> {
  return quietCandidates({
    now,
    before: new Date(now.getTime() - (QUIET_AFTER_DAYS - CLOSING_SOON_DAYS) * DAY),
    after: new Date(now.getTime() - QUIET_AFTER_DAYS * DAY),
    take,
  });
}

/** Close everyone quiet for QUIET_AFTER_DAYS. Returns how many closed. */
export async function closeQuietCandidates(now = new Date()): Promise<number> {
  const due = await quietCandidates({ now, before: new Date(now.getTime() - QUIET_AFTER_DAYS * DAY) });
  let closed = 0;
  for (const c of due) {
    const done = await prisma.$transaction(async (tx) => {
      // Only if they're still where we found them — a recruiter acting in
      // the same minute wins.
      const n = await tx.candidate.updateMany({
        where: { id: c.id, stage: c.stage, deletedAt: null },
        data: { stage: 'WITHDRAWN', withdrawnReason: AUTO_CLOSE_REASON, stageChangedAt: now },
      });
      if (n.count === 0) return false;
      await recordCandidateEvent(tx, {
        candidateId: c.id,
        kind: 'STAGE_CHANGED',
        actorUserId: null,
        fromStage: c.stage,
        toStage: 'WITHDRAWN',
        body: AUTO_CLOSE_REASON,
        metadata: { automatic: true, lastActivity: c.lastActivity.toISOString() },
      });
      return true;
    });
    if (!done) continue;
    closed += 1;
    enqueueAudit(
      {
        actorUserId: null,
        action: 'recruiting.candidate_auto_closed',
        entityType: 'Candidate',
        entityId: c.id,
        metadata: { fromStage: c.stage, lastActivity: c.lastActivity.toISOString() },
      },
      'recruiting.candidate_auto_closed',
    );
  }
  return closed;
}

/* ----- The clean-up sweep ------------------------------------------------- */

let timer: NodeJS.Timeout | null = null;

/** Close quiet candidates and expire invites nobody answered. */
export async function runRecruitingCleanup(now = new Date()): Promise<{ candidatesClosed: number; invitesExpired: number }> {
  const candidatesClosed = await closeQuietCandidates(now);
  const invitesExpired = await expireStaleInvites(now);
  return { candidatesClosed, invitesExpired };
}

export function startRecruitingCleanupCron(): void {
  if (timer) return;
  const seconds = env.RECRUITING_CLEANUP_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void runRecruitingCleanup()
      .then((r) => {
        if (r.candidatesClosed || r.invitesExpired) {
          console.log(`[alto-people/api] recruiting clean-up: ${r.candidatesClosed} candidates closed, ${r.invitesExpired} invites expired`);
        }
      })
      .catch((err) => console.error('[alto-people/api] recruiting clean-up failed', err));
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(`[alto-people/api] recruiting clean-up armed (every ${seconds}s; quiet after ${QUIET_AFTER_DAYS}d)`);
}

export function stopRecruitingCleanupCron(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
