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
 *
 * That includes the day the clean-up first runs somewhere: everyone
 * already past the limit would close at once, unannounced. So the first
 * sweep starts a GRACE_DAYS clock (OrgSetting.recruitingCleanupSince);
 * until it runs out nothing closes, and the overdue show as closing when
 * it ends. Expired onboarding invites wait for the same clock.
 */

export const QUIET_AFTER_DAYS = 30;
export const CLOSING_SOON_DAYS = 5;
export const AUTO_CLOSE_REASON = `No response for ${QUIET_AFTER_DAYS} days — closed automatically`;
/** How long the first sweep waits before closing anything. */
export const GRACE_DAYS = CLOSING_SOON_DAYS;

const DAY = 86_400_000;

/**
 * The earliest anything may close: GRACE_DAYS after the first sweep here —
 * or after now, when no sweep has run yet (the first one is about to).
 */
export async function closingStartsAt(now: Date): Promise<Date> {
  const row = await prisma.orgSetting.findUnique({ where: { id: 'singleton' }, select: { recruitingCleanupSince: true } });
  const since = row?.recruitingCleanupSince ?? now;
  return new Date(since.getTime() + GRACE_DAYS * DAY);
}

/** Start the grace clock on the first sweep; later sweeps leave it be. Safe to race. */
async function startGraceClock(now: Date): Promise<Date> {
  await prisma.orgSetting.createMany({ data: [{ id: 'singleton' }], skipDuplicates: true });
  await prisma.orgSetting.updateMany({
    where: { id: 'singleton', recruitingCleanupSince: null },
    data: { recruitingCleanupSince: now },
  });
  return closingStartsAt(now);
}
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
 * Open-stage candidates whose last activity is before `before`, with
 * nothing pending. Oldest first. `closingStartsAt` holds everyone's close
 * date back to the end of the grace period.
 */
export async function quietCandidates(opts: {
  now: Date;
  before: Date;
  closingStartsAt?: Date;
  take?: number;
}): Promise<QuietCandidate[]> {
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
    const due = last.getTime() + QUIET_AFTER_DAYS * DAY;
    out.push({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      position: c.position,
      stage: c.stage,
      lastActivity: last,
      closesAt: new Date(Math.max(due, opts.closingStartsAt?.getTime() ?? 0)),
    });
  }
  return out;
}

/**
 * Who closes within CLOSING_SOON_DAYS — the recruiter's warning. Anyone
 * already past the limit is on it too: during the grace period they close
 * when it ends, and after it the next sweep takes them.
 */
export async function closingSoon(now: Date, take = 1000): Promise<QuietCandidate[]> {
  return quietCandidates({
    now,
    before: new Date(now.getTime() - (QUIET_AFTER_DAYS - CLOSING_SOON_DAYS) * DAY),
    closingStartsAt: await closingStartsAt(now),
    take,
  });
}

/**
 * Close everyone quiet for QUIET_AFTER_DAYS whose close date has come.
 * The sweep passes `closingStartsAt`; without it there's no grace period.
 * Returns how many closed.
 */
export async function closeQuietCandidates(now = new Date(), startsAt?: Date): Promise<number> {
  const due = (
    await quietCandidates({ now, before: new Date(now.getTime() - QUIET_AFTER_DAYS * DAY), closingStartsAt: startsAt })
  ).filter((c) => c.closesAt <= now);
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

/**
 * Close quiet candidates and expire invites nobody answered — once the
 * grace period that the first sweep starts has run out.
 */
export async function runRecruitingCleanup(
  now = new Date(),
): Promise<{ candidatesClosed: number; invitesExpired: number; graceUntil: Date | null }> {
  const startsAt = await startGraceClock(now);
  if (now < startsAt) return { candidatesClosed: 0, invitesExpired: 0, graceUntil: startsAt };
  const candidatesClosed = await closeQuietCandidates(now, startsAt);
  const invitesExpired = await expireStaleInvites(now);
  return { candidatesClosed, invitesExpired, graceUntil: null };
}

export function startRecruitingCleanupCron(): void {
  if (timer) return;
  const seconds = env.RECRUITING_CLEANUP_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  let announcedGrace = false;
  const run = () => {
    void runRecruitingCleanup()
      .then((r) => {
        if (r.graceUntil && !announcedGrace) {
          announcedGrace = true;
          console.log(`[alto-people/api] recruiting clean-up: grace period — nothing closes before ${r.graceUntil.toISOString()}`);
        }
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
