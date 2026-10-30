import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { listHugoActivity } from '../lib/hugoActivity.js';
import { contextFor, type Asker } from '../lib/hugoRegistry.js';

/**
 * GET /hugo/activity?before=&limit= — everything Hugo did for the caller,
 * newest first (lib/hugoActivity): their tasks' trails, notes they acted
 * on, actions they confirmed through him, the month's allowance running
 * out. Their own rows only. `next` in the answer is the `before` of the
 * page after.
 */
export const hugoActivityRouter = Router();

const Query = z.object({
  before: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

hugoActivityRouter.get('/', requireAuth, async (req, res) => {
  // Someone the assistant serves, while it is on (the same door as the Tasks tab).
  await contextFor(req.user! as Asker);
  const { before, limit } = Query.parse(req.query);
  res.json(await listHugoActivity(req.user!.id, { before: before || null, limit }));
});
