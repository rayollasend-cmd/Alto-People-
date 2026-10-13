import { Router } from 'express';
import { requireCapability } from '../middleware/auth.js';
import { TENANT_SCOPED_MODELS, resetTenantObservations, tenancyMode, tenantObservations } from '../lib/tenantGuard.js';

/**
 * Brief 2-1, step two — what the observe-mode wall has seen since boot:
 * the queries that ran with no tenant in context (jobs, webhooks,
 * scripts) and any write or filter that named another tenant, by call
 * site. The list the enforcing step has to empty.
 */
export const tenancyRouter = Router();

const MANAGE = requireCapability('manage:org');

tenancyRouter.get('/admin/tenancy/observations', MANAGE, (_req, res) => {
  const rows = tenantObservations();
  res.json({
    mode: tenancyMode(),
    scopedModels: TENANT_SCOPED_MODELS.size,
    since: process.uptime(),
    totals: {
      callSites: rows.length,
      calls: rows.reduce((n, r) => n + r.count, 0),
      byKind: rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + r.count }), {}),
    },
    observations: rows,
  });
});

tenancyRouter.post('/admin/tenancy/observations/reset', MANAGE, (_req, res) => {
  resetTenantObservations();
  res.status(204).end();
});
