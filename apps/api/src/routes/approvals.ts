import { Router } from 'express';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import {
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
      const [swaps, pickups, timeOff, timesheets] = await Promise.all([
        prisma.shiftSwapRequest.count({
          where: { status: 'PEER_ACCEPTED', shift: { is: scopeShifts(user) } },
        }),
        prisma.openShiftClaim.count({
          where: { status: 'PENDING', shift: { is: scopeShifts(user) } },
        }),
        prisma.timeOffRequest.count({
          where: { status: 'PENDING', ...scopeTimeOffRequests(user) },
        }),
        prisma.timeEntry.count({
          where: { status: 'COMPLETED', ...scopeTimeEntries(user) },
        }),
      ]);
      res.json({
        swaps,
        pickups,
        timeOff,
        timesheets,
        total: swaps + pickups + timeOff + timesheets,
      });
    } catch (err) {
      next(err);
    }
  },
);
