import { Router } from 'express';
import { z } from 'zod';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from '../lib/audit.js';
import { listJobs, runJobNow } from '../lib/jobs.js';

/**
 * The scheduled-jobs panel (Settings & Trust → Reliability). What each
 * registered job did last, whether it failed, and when it runs next —
 * so a cron that defaults to off, or that has been failing since a
 * deploy, is a line on a page instead of a guess.
 *
 *   GET  /admin/jobs            every registered job with its status
 *   POST /admin/jobs/:name/run  run one now (audited)
 */
export const scheduledJobsRouter = Router();

const VIEW = requireCapability('view:product-analytics');
const MANAGE = requireCapability('manage:org');

scheduledJobsRouter.get('/', VIEW, (_req, res) => {
  res.json({ jobs: listJobs(), now: new Date().toISOString() });
});

scheduledJobsRouter.post('/:name/run', MANAGE, async (req, res) => {
  const name = z.string().min(1).max(80).parse(req.params.name);
  const status = await runJobNow(name);
  if (!status) throw new HttpError(404, 'not_found', 'No scheduled job by that name.');
  enqueueAudit(
    { actorUserId: req.user!.id, clientId: null, action: 'jobs.run_now', entityType: 'ScheduledJob', entityId: name, metadata: { ok: !status.lastError, lastError: status.lastError } },
    'jobs.run_now',
  );
  res.json({ job: status });
});
