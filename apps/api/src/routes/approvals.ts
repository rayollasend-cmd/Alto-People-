import { Router, type Request } from 'express';
import { prisma } from '../db.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import {
  effectiveClientIdFilter,
  scopeShifts,
  scopeTimeOffRequests,
} from '../lib/scope.js';
import { pendingTimeWhere } from '../lib/pendingTime.js';
import { countDecidableApprovals, listDecidableApprovals, type Decider } from '../lib/proposalDecisions.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * One cheap COUNT per manager decision queue, powering the badge on the
 * /approvals nav entry. The queues live in four different tables; the
 * page itself renders them via their own routers — this endpoint exists
 * only so navigation can say "7 things are waiting" without loading any
 * of them.
 *
 * Every count is scoped with the SAME helpers the queue pages use, so a
 * client-bounded SHIFT_SUPERVISOR's badge matches what their page shows
 * (it used to count the whole org).
 */
export const approvalsRouter = Router();

type SessionUser = NonNullable<Request['user']>;

export interface ApprovalQueueCounts {
  swaps: number;
  pickups: number;
  timeOff: number;
  timesheets: number;
  clockIns: number;
  /** Agent proposals this person may decide (lib/proposalDecisions: the server's one rule). */
  proposals: number;
  total: number;
}

/** The session user as the decision rule reads it. */
export function deciderOf(user: SessionUser): Decider {
  const u = user as SessionUser & { clientId?: string | null; locationId?: string | null };
  return { id: u.id, role: u.role, clientId: u.clientId ?? null, locationId: u.locationId ?? null };
}

/**
 * The manager's approval queues as counts, scoped exactly as the queue
 * pages scope their lists. Shared by GET /approvals/count (the nav badge)
 * and GET /me/inbox (the cross-module inbox) so the two never disagree.
 */
export async function countApprovalQueues(user: SessionUser): Promise<ApprovalQueueCounts> {
  // Same clamp rule as the clock-in-request routes in time.ts: bounded
  // callers count only their own client; unassigned bounded callers
  // fail closed on an impossible id.
  const clockInClamp = (() => {
    const clamped = effectiveClientIdFilter(user, undefined);
    if (clamped === null) {
      return { clientId: '00000000-0000-0000-0000-000000000000' };
    }
    return clamped ? { clientId: clamped } : {};
  })();
  const [swaps, pickups, timeOff, timesheets, clockIns, proposals] = await Promise.all([
    prisma.shiftSwapRequest.count({
      where: { status: 'PEER_ACCEPTED', shift: { is: scopeShifts(user) } },
    }),
    prisma.openShiftClaim.count({
      where: { status: 'PENDING', shift: { is: scopeShifts(user) } },
    }),
    prisma.timeOffRequest.count({
      where: { status: 'PENDING', ...scopeTimeOffRequests(user) },
    }),
    // The one pending-time predicate (lib/pendingTime): the same 90-day
    // window the queue's link carries and the queue's list reads, so this
    // number is what the person finds when they open it.
    prisma.timeEntry.count({ where: pendingTimeWhere(user) }),
    // Walk-in clock-ins the schedule gate parked. Bounded to 48h — a
    // PENDING request older than that is past the approval age limit
    // anyway (see time.ts), so it shouldn't inflate the badge.
    prisma.clockInRequest.count({
      where: {
        status: 'PENDING',
        requestedAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
        ...clockInClamp,
      },
    }),
    // What an agent proposes and this person may decide: the Proposals queue on the same page.
    countDecidableApprovals(prisma, tenantIdForWrite(), deciderOf(user)),
  ]);
  return {
    swaps,
    pickups,
    timeOff,
    timesheets,
    clockIns,
    proposals,
    total: swaps + pickups + timeOff + timesheets + clockIns + proposals,
  };
}

/**
 * GET /approvals/proposals — the agent proposals waiting on the signed-in
 * person, with their evidence, each decidable by them. Any signed-in person
 * may ask: the list is already filtered to what the rule lets them decide,
 * so a site supervisor without view:org sees their own shifts' proposals.
 */
approvalsRouter.get('/proposals', requireAuth, async (req, res, next) => {
  try {
    res.json({ approvals: await listDecidableApprovals(prisma, tenantIdForWrite(), deciderOf(req.user!)) });
  } catch (err) {
    next(err);
  }
});

approvalsRouter.get(
  '/count',
  requireCapability('manage:scheduling'),
  async (req, res, next) => {
    try {
      res.json(await countApprovalQueues(req.user!));
    } catch (err) {
      next(err);
    }
  },
);
