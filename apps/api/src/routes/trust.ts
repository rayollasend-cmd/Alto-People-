import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAnyCapability } from '../middleware/auth.js';
import { loginIpLimiter } from '../middleware/rateLimit.js';
import { trustSummary, trustSummaryPublic } from '../lib/trustCenter.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * The Trust Center (UX upgrade step 4).
 *
 *   GET /trust/public   no sign-in: statuses, dates, counts, the sub-processor
 *                       list and the commitments. Cached a minute; rate-limited
 *                       like the login page. Never a control's detail, an
 *                       address or an identifier.
 *   GET /trust          the signed-in view (manage:org, view:executive or
 *                       view:audit): the public summary plus this tenant's
 *                       chain, retention, archives, SIEM, sign-in, agents,
 *                       decision records and access review.
 */
export const trustRouter = Router();

trustRouter.get('/public', loginIpLimiter, async (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(await trustSummaryPublic(prisma));
});

trustRouter.get('/', requireAnyCapability('manage:org', 'view:executive', 'view:audit'), async (_req, res) => {
  res.json(await trustSummary(prisma, tenantIdForWrite()));
});
