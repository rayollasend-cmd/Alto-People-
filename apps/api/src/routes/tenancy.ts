import { Router } from 'express';
import { requireCapability } from '../middleware/auth.js';
import { TENANT_SCOPED_MODELS, resetTenantObservations, tenancyMode, tenantObservations } from '../lib/tenantGuard.js';
import { BUSINESS_MODELS, TENANT_MODULES, TENANT_MODULE_LABEL, TERM_KEYS, defaultModulesFor, defaultTerminologyFor } from '@alto-people/shared';
import { tenantIdForWrite } from '../lib/tenant.js';
import { loadTenantProfile, setTenantProfile } from '../lib/tenantProfile.js';

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

/* ===== Brief 2-1b: the tenant profile ==================================== */

tenancyRouter.get('/admin/tenant/profile', requireCapability('view:hr-admin'), async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const profile = await loadTenantProfile(tenantId);
  res.json({
    tenantId,
    profile,
    defaults: { modules: defaultModulesFor(profile.businessModel), terminology: defaultTerminologyFor(profile.businessModel) },
    catalog: { businessModels: BUSINESS_MODELS, modules: TENANT_MODULES.map((key) => ({ key, label: TENANT_MODULE_LABEL[key] })), termKeys: TERM_KEYS },
  });
});

tenancyRouter.put('/admin/tenant/profile', MANAGE, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const profile = await setTenantProfile(tenantId, req.body, req.user!.id);
  res.json({ tenantId, profile });
});
