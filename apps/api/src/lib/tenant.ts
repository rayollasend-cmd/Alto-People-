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
