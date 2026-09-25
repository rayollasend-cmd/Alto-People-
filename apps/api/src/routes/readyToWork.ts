import { Router } from 'express';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { readyToScheduleForSupervisor, readyToWorkStatus } from '../lib/readyToWork.js';

/**
 * Ready-to-work handoffs (lib/readyToWork).
 *
 *   GET /ready-to-work/mine                    a shift supervisor's queue:
 *                                              hires handed to them with no
 *                                              first shift yet
 *   GET /ready-to-work/associates/:associateId HR / Workforce: who was told,
 *                                              when, and whether it closed
 *
 * The associate's own kit lives under /self/me/ready-to-work.
 */
export const readyToWorkRouter = Router();

readyToWorkRouter.get('/mine', requireAuth, async (req, res, next) => {
  try {
    res.json({ items: await readyToScheduleForSupervisor(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

readyToWorkRouter.get(
  '/associates/:associateId',
  requireCapability('view:onboarding'),
  async (req, res, next) => {
    try {
      const associateId = req.params.associateId;
      // Client-bounded staff only see their own client's hires.
      const bound = req.user!.clientId;
      if (bound) {
        const row = await prisma.readyToWorkHandoff.findUnique({
          where: { associateId },
          select: { clientId: true },
        });
        if (row && row.clientId !== bound) throw new HttpError(404, 'not_found', 'Not found.');
      }
      res.json({ status: await readyToWorkStatus(prisma, associateId) });
    } catch (err) {
      next(err);
    }
  },
);
