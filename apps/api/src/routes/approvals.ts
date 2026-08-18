import { Router } from 'express';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import {
  effectiveClientIdFilter,
  scopeShifts,
  scopeTimeEntries,
  scopeTimeOffRequests,
} from '../lib/scope.js';

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

approvalsRouter.get(
  '/count',
  requireCapability('manage:scheduling'),
  async (req, res, next) => {
    try {
      const user = req.user!;
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
      const [swaps, pickups, timeOff, timesheets, clockIns] = await Promise.all([
        prisma.shiftSwapRequest.count({
          where: { status: 'PEER_ACCEPTED', shift: { is: scopeShifts(user) } },
        }),
        prisma.openShiftClaim.count({
          where: { status: 'PENDING', shift: { is: scopeShifts(user) } },
        }),
        prisma.timeOffRequest.count({
          where: { status: 'PENDING', ...scopeTimeOffRequests(user) },
        }),
        // Bounded to a 90-day window: COMPLETED is a state entries can sit
        // in forever, so an all-time count both grows unboundedly and
        // stops matching what the queue page (recent-first, capped) shows.
        prisma.timeEntry.count({
          where: {
            status: 'COMPLETED',
            clockInAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
            ...scopeTimeEntries(user),
          },
        }),
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
      ]);
      res.json({
        swaps,
        pickups,
        timeOff,
        timesheets,
        clockIns,
        total: swaps + pickups + timeOff + timesheets + clockIns,
      });
    } catch (err) {
      next(err);
    }
  },
);
