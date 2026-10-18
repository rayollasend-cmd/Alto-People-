import { Router } from 'express';
import { z } from 'zod';
import { requireCapability } from '../middleware/auth.js';
import { buildStaffingPlan } from '../lib/staffingPlan.js';

/**
 * GET /headcount/staffing-plan?weeks=12&clientId= — heads required against
 * heads placed and scheduled, store by store, week by week, with the bill
 * at today's rates (lib/staffingPlan). Inside the caller's reach.
 */
export const staffingPlanRouter = Router();

staffingPlanRouter.get('/headcount/staffing-plan', requireCapability('view:org'), async (req, res) => {
  const q = z
    .object({ weeks: z.coerce.number().int().min(4).max(26).default(12), clientId: z.string().uuid().optional() })
    .parse(req.query);
  res.json(await buildStaffingPlan(req.user!, { weeks: q.weeks, clientId: q.clientId ?? null }));
});
