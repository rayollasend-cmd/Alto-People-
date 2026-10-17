import { Router } from 'express';
import { z } from 'zod';
import { PromotionInputSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { assertSameTenant } from '../lib/sameTenant.js';
import { listPromotions, proposePromotion } from '../lib/promotions.js';
import { deciderFrom } from './approvalRequests.js';

/**
 * Promotions as a workflow: POST opens one (and the approval that decides
 * it); the list shows where each stands. Applying happens in the engine
 * when a second manage:comp holder approves.
 */
export const promotionsRouter = Router();

promotionsRouter.get('/', requireCapability('view:comp'), async (req, res, next) => {
  try {
    const q = z.object({ associateId: z.string().uuid().optional(), status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'APPLIED']).optional() }).parse(req.query);
    res.json({ promotions: await listPromotions(prisma, q) });
  } catch (err) {
    next(err);
  }
});

promotionsRouter.post('/', requireCapability('manage:comp'), async (req, res, next) => {
  try {
    const input = PromotionInputSchema.parse(req.body);
    await assertSameTenant('associate', input.associateId);
    res.status(202).json(await proposePromotion(prisma, input, deciderFrom(req.user!)));
  } catch (err) {
    next(err);
  }
});
