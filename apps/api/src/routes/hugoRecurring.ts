import { Router } from 'express';
import { z } from 'zod';
import { HugoRecurringChangeSchema } from '@alto-people/shared';
import { requireAuth } from '../middleware/auth.js';
import { changeRecurring } from '../lib/hugoRecurring.js';
import { contextFor, type Asker } from '../lib/hugoRegistry.js';
import { getHugoTask } from '../lib/hugoTasks.js';

/**
 * PATCH /hugo/recurring/:id { cadence?, weekday?, time?, paused? } — the
 * person changes when one of their briefs comes, or pauses / resumes it
 * (lib/hugoRecurring). Their own only (anyone else's is 404). Stopping is
 * POST /hugo/tasks/:id/cancel, like every task; "Keep going" is the task's
 * answer (POST /hugo/tasks/:id/respond { choice: 'KEEP_GOING' }).
 */
export const hugoRecurringRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });

hugoRecurringRouter.patch('/:id', requireAuth, async (req, res) => {
  await contextFor(req.user! as Asker);
  const { id } = IdParam.parse(req.params);
  const change = HugoRecurringChangeSchema.parse(req.body ?? {});
  await changeRecurring(req.user!, id, change);
  res.json({ task: await getHugoTask(req.user!.id, id) });
});
