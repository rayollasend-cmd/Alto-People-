import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Tenant context (Brief 2-1, step one).
 *
 *   One customer organization per tenant. Today there is one, Alto HR,
 *   and every row carries its id by database default. This module holds
 *   the request-scoped context that later steps enforce against: the
 *   Prisma extension (step two) reads `currentTenantId()` to inject the
 *   tenant into every query, and the database policy (step four) reads
 *   the same id set per transaction.
 *
 *   Nothing here enforces anything yet. A request with no resolvable
 *   tenant runs as Alto HR, and `withPlatformScope` is a plain passthrough
 *   that only marks the context; the audit line for it comes with the
 *   extension.
 */

/** Alto HR, tenant 1. Fixed so every environment agrees; the migration seeds it. */
export const ALTO_TENANT_ID = '00000000-0000-4000-8000-000000000001';

export type TenantSource = 'session' | 'api-key' | 'api-client' | 'agent' | 'kiosk' | 'scim' | 'job' | 'script' | 'default' | 'platform';

export interface TenantContext {
  tenantId: string;
  source: TenantSource;
  /** Set inside withPlatformScope: the caller may see every tenant. */
  platform: boolean;
  /** An anonymous request that has learned its tenant from the record it resolved. */
  adopted?: boolean;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** The tenant of the current request, job or script, or null outside any context. */
export function tenantContext(): TenantContext | null {
  return storage.getStore() ?? null;
}

export function currentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

/** The tenant to write for a new row: the context's, else Alto HR until step two makes a missing context an error. */
export function tenantIdForWrite(): string {
  return storage.getStore()?.tenantId ?? ALTO_TENANT_ID;
}

/**
 * Runs `fn` inside the tenant's context. The await happens INSIDE the
 * context on purpose: a Prisma call is a lazy promise that executes when
 * it is awaited, so `runWithTenant(id, src, () => prisma.x.findMany())`
 * must settle before the context ends, or the query runs outside it.
 */
export function runWithTenant<T>(tenantId: string, source: TenantSource, fn: () => Promise<T> | T): Promise<T> {
  return storage.run({ tenantId, source, platform: false }, async () => await fn());
}

type PlatformScopeHook = (ctx: TenantContext, callSite: string) => void;
const platformScopeHooks: PlatformScopeHook[] = [];

/** Step two: what to do each time the platform scope opens (the boot registers the audit line). */
export function onPlatformScope(hook: PlatformScopeHook): void {
  platformScopeHooks.push(hook);
}

function callerOf(stack: string | undefined): string {
  for (const raw of (stack ?? '').split('\n').slice(2)) {
    const line = raw.trim();
    if (!line.startsWith('at ') || /tenant\.ts|node_modules|node:internal/.test(line)) continue;
    const m = /\(?((?:file:\/\/\/)?[^()]+?):(\d+):\d+\)?$/.exec(line);
    if (m) return `${m[1]!.replace(/^file:\/\/\//, '')}:${m[2]}`;
  }
  return 'unknown';
}

/** Jobs and scripts that must see every tenant run here; every use is on the record (onPlatformScope). */
export function withPlatformScope<T>(fn: () => Promise<T> | T): Promise<T> {
  const current = storage.getStore();
  const ctx: TenantContext = { tenantId: current?.tenantId ?? ALTO_TENANT_ID, source: 'platform', platform: true };
  const callSite = callerOf(new Error().stack);
  for (const hook of platformScopeHooks) {
    try {
      hook(ctx, callSite);
    } catch (err) {
      console.error('[tenancy] platform scope hook failed:', err);
    }
  }
  return storage.run(ctx, async () => await fn());
}

/**
 * Identity resolution: the reads that FIND whose request this is (the
 * session's user, a public link's row, a webhook's subject) run before
 * any tenant is known. They see every tenant, are not audited per call
 * (they run on every request), and must only look rows up by a globally
 * unique key — never search. Use `adoptTenant` with what they find.
 */
export function withIdentityScope<T>(fn: () => Promise<T> | T): Promise<T> {
  const current = storage.getStore();
  return storage.run({ tenantId: current?.tenantId ?? ALTO_TENANT_ID, source: 'platform', platform: true }, async () => await fn());
}

/**
 * An anonymous request (a public link, a login, a kiosk device) learns its
 * tenant from the row it just resolved: the rest of the request runs as
 * that tenant. Only an unbound request may adopt — a signed-in session's
 * tenant never changes mid-request. Returns false when refused.
 */
export function adoptTenant(tenantId: string | null | undefined, source: TenantSource = 'default'): boolean {
  const ctx = storage.getStore();
  if (!ctx || !tenantId || ctx.platform) return false;
  if (ctx.source !== 'default' && ctx.tenantId !== tenantId) return false;
  // Once bound, an anonymous request keeps that tenant: a second, different
  // record can't move it.
  if (ctx.adopted && ctx.tenantId !== tenantId) return false;
  ctx.tenantId = tenantId;
  ctx.adopted = true;
  if (source !== 'default') ctx.source = source;
  return true;
}

/**
 * Resolve an anonymous request's tenant from a row found by a unique key,
 * then adopt it. `find` runs in the identity scope and returns the row's
 * tenantId (or null when there is no such row).
 */
export async function resolveTenantFrom(find: () => Promise<string | null | undefined>, source: TenantSource = 'default'): Promise<string | null> {
  const tenantId = await withIdentityScope(find);
  if (tenantId) adoptTenant(tenantId, source);
  return tenantId ?? null;
}

/**
 * Resolves the tenant for a request and runs the rest of the chain inside
 * it. Step one: a session user's tenant when the user row carries one,
 * otherwise Alto HR. API keys, agent credentials, kiosk devices and the
 * public pages get their own resolvers in the enforcing step.
 */
export function tenantMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const fromUser = (req.user as { tenantId?: string | null } | undefined)?.tenantId ?? null;
  const ctx: TenantContext = fromUser ? { tenantId: fromUser, source: 'session', platform: false } : { tenantId: ALTO_TENANT_ID, source: 'default', platform: false };
  storage.run(ctx, () => next());
}
