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

export type TenantSource = 'session' | 'api-key' | 'agent' | 'kiosk' | 'job' | 'script' | 'default' | 'platform';

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

export function runWithTenant<T>(tenantId: string, source: TenantSource, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run({ tenantId, source, platform: false }, fn);
}

/** Jobs and scripts that must see every tenant run here; the extension (step two) logs each use. */
export function withPlatformScope<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const current = storage.getStore();
  return storage.run({ tenantId: current?.tenantId ?? ALTO_TENANT_ID, source: 'platform', platform: true }, fn);
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
