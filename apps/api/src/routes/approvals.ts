import { Router } from 'express';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * One cheap COUNT per manager decision queue, powering the badge on the
 * /approvals nav entry. The queues live in four different tables; the
 * page itself renders them via their own routers — this endpoint exists
 * only so navigation can say "7 things are waiting" without loading any
 * of them.
 */
export const approvalsRouter = Router();

approvalsRouter.get(
  '/count',
  requireCapability('manage:scheduling'),
  async (_req, res, next) => {
    try {
      const [swaps, pickups, timeOff, timesheets] = await Promise.all([
        prisma.shiftSwapRequest.count({ where: { status: 'PEER_ACCEPTED' } }),
        prisma.openShiftClaim.count({ where: { status: 'PENDING' } }),
        prisma.timeOffRequest.count({ where: { status: 'PENDING' } }),
        prisma.timeEntry.count({ where: { status: 'COMPLETED' } }),
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
