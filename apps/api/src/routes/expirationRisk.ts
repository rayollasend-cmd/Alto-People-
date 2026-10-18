import { Router } from 'express';
import { z } from 'zod';
import { requireCapability } from '../middleware/auth.js';
import { buildExpirationRisk } from '../lib/expirationRisk.js';

/**
 * GET /expirations/risk — expiring credentials with the person's store,
 * their next shift, and the first shift each lapse blocks (lib/expirationRisk);
 * plus the 13-week timeline by store. Inside the caller's reach.
 */
export const expirationRiskRouter = Router();

const Query = z.object({
  days: z.coerce.number().int().min(7).max(365).default(90),
  clientId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  qualificationId: z.string().uuid().optional(),
  isCert: z.enum(['true', 'false']).optional(),
});

expirationRiskRouter.get('/expirations/risk', requireCapability('view:org'), async (req, res) => {
  const q = Query.parse(req.query);
  res.json(
    await buildExpirationRisk(req.user!, {
      days: q.days,
      clientId: q.clientId ?? null,
      storeId: q.storeId ?? null,
      qualificationId: q.qualificationId ?? null,
      isCert: q.isCert === undefined ? undefined : q.isCert === 'true',
    }),
  );
});
