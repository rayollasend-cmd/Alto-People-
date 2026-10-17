import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import {
  TenantProfileSchema,
  TenantModulesSchema,
  TermKeySchema,
  TermTextSchema,
  UpdateTenantProfileInputSchema,
  defaultModulesFor,
  defaultTerminologyFor,
  type BusinessModel,
  type TenantModule,
  type TenantProfile,
  type Terminology,
  type UpdateTenantProfileInput,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { ensureBrandingLoaded } from './branding.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from './tenant.js';

/**
 * Brief 2-1b, step 1 — the tenant profile at runtime.
 *
 *   loadTenantProfile   the validated profile for a tenant: the business
 *                       model's defaults with the stored switches and terms
 *                       laid over them, cached for a minute.
 *   moduleOn            one switch, for a route, a job or Hugo.
 *   requireModule       the route gate: an off module answers 404, so an
 *                       off module is indistinguishable from an absent one.
 *   setTenantProfile    the only write path; validated, audited.
 */

const cache = new Map<string, { at: number; profile: TenantProfile }>();
const CACHE_MS = 60_000;

function merge(model: BusinessModel, modules: unknown, terminology: unknown): TenantProfile {
  const baseModules = defaultModulesFor(model);
  const baseTerms = defaultTerminologyFor(model);
  const storedModules = TenantModulesSchema.partial().safeParse(modules ?? {});
  const mergedModules = { ...baseModules, ...(storedModules.success ? storedModules.data : {}) };
  const mergedTerms: Terminology = { ...baseTerms };
  if (terminology && typeof terminology === 'object') {
    for (const [k, v] of Object.entries(terminology as Record<string, unknown>)) {
      const key = TermKeySchema.safeParse(k);
      const text = TermTextSchema.partial().safeParse(v);
      if (key.success && text.success) mergedTerms[key.data] = { ...mergedTerms[key.data], ...text.data };
    }
  }
  return TenantProfileSchema.parse({ businessModel: model, modules: mergedModules, terminology: mergedTerms });
}

export async function loadTenantProfile(tenantId: string = tenantIdForWrite()): Promise<TenantProfile> {
  const hit = cache.get(tenantId);
  if (hit && process.env.NODE_ENV !== 'test' && Date.now() - hit.at < CACHE_MS) return hit.profile;
  const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { businessModel: true, modules: true, terminology: true } });
  const profile = merge(row?.businessModel ?? 'WORKFORCE_PROVIDER', row?.modules, row?.terminology);
  cache.set(tenantId, { at: Date.now(), profile });
  return profile;
}

/** The cached profile, for synchronous paths; null until the first load. */
export function tenantProfileSync(tenantId: string = tenantIdForWrite()): TenantProfile | null {
  return cache.get(tenantId)?.profile ?? null;
}

export function invalidateTenantProfile(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function moduleOn(module: TenantModule, tenantId: string = tenantIdForWrite()): Promise<boolean> {
  return (await loadTenantProfile(tenantId)).modules[module];
}

/** Route gate: 404 when the current tenant has the module off. */
export function requireModule(module: TenantModule) {
  return async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (await moduleOn(module)) next();
      else next(new HttpError(404, 'not_found', 'Not found.'));
    } catch (err) {
      next(err);
    }
  };
}

export async function setTenantProfile(tenantId: string, input: UpdateTenantProfileInput, actorUserId: string | null): Promise<TenantProfile> {
  const parsed = UpdateTenantProfileInputSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid tenant profile.', parsed.error.flatten());
  const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { businessModel: true, modules: true, terminology: true } });
  if (!row) throw new HttpError(404, 'tenant_not_found', 'No such tenant.');
  const before = merge(row.businessModel, row.modules, row.terminology);
  const model = parsed.data.businessModel ?? row.businessModel;
  const base = parsed.data.resetToDefaults ? merge(model, {}, {}) : merge(model, row.modules, row.terminology);
  const next = merge(model, { ...base.modules, ...(parsed.data.modules ?? {}) }, mergeTerms(base.terminology, parsed.data.terminology));
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { businessModel: model, modules: next.modules as Prisma.InputJsonValue, terminology: next.terminology as Prisma.InputJsonValue },
  });
  invalidateTenantProfile(tenantId);
  const changedModules = (Object.keys(next.modules) as TenantModule[]).filter((k) => next.modules[k] !== before.modules[k]);
  enqueueAudit(
    {
      actorUserId,
      clientId: null,
      action: 'tenant.profile_updated',
      entityType: 'Tenant',
      entityId: tenantId,
      metadata: {
        businessModel: { from: before.businessModel, to: model },
        modules: Object.fromEntries(changedModules.map((k) => [k, { from: before.modules[k], to: next.modules[k] }])),
        termsChanged: Object.keys(parsed.data.terminology ?? {}),
        reset: !!parsed.data.resetToDefaults,
      },
    },
    'tenancy',
  );
  return next;
}

function mergeTerms(base: Terminology, patch: UpdateTenantProfileInput['terminology']): Terminology {
  if (!patch) return base;
  const out: Terminology = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof Terminology;
    if (v) out[key] = { ...out[key], ...v };
  }
  return out;
}

/** What the session carries: the profile of the user's tenant (Alto HR when the user has none), and what its team calls the assistant. */
export async function tenantForSession(user: object | null | undefined): Promise<(TenantProfile & { id: string; assistantName: string }) | null> {
  if (!user) return null;
  const id = (user as { tenantId?: string | null }).tenantId ?? ALTO_TENANT_ID;
  const [profile, branding] = await Promise.all([loadTenantProfile(id), ensureBrandingLoaded(prisma, id)]);
  return { id, assistantName: branding.assistantName, ...profile };
}
