import { prisma } from '../db.js';
import { runWithTenant, withPlatformScope } from './tenant.js';

/**
 * Brief 2-1b step 0 (and 2-1 §9.4): timed jobs run per tenant.
 *
 *   Every sweep, digest and retention job used to run once for the one
 *   org with no tenant in context. Now each runs once PER ACTIVE TENANT,
 *   inside that tenant's context, so what it reads and writes is that
 *   tenant's — and a failure for one tenant never stops the next. A job
 *   that must see the whole platform (telemetry flushes, backups, the
 *   reliability digest) runs under the audited platform scope instead.
 *
 *   With one tenant on file this changes nothing on disk: the context's
 *   tenant is the database default. It is the prerequisite for gating a
 *   job by a tenant's modules (Brief 2-1b step 1).
 */

let cache: { at: number; ids: string[] } | null = null;
const CACHE_MS = 60_000;

/** Every ACTIVE tenant, oldest first (Alto HR is first). Cached for a minute outside tests. */
export async function activeTenantIds(now: number = Date.now()): Promise<string[]> {
  if (cache && process.env.NODE_ENV !== 'test' && now - cache.at < CACHE_MS) return cache.ids;
  const rows = await prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  cache = { at: now, ids: rows.map((r) => r.id) };
  return cache.ids;
}

export function resetTenantCache(): void {
  cache = null;
}

export interface TenantJobRun {
  ran: number;
  failed: number;
}

/** Run `fn` once per active tenant, each inside that tenant's context; log and continue on a failure. */
export async function runForEachTenant(name: string, fn: (tenantId: string) => Promise<unknown> | unknown): Promise<TenantJobRun> {
  const ids = await activeTenantIds();
  let failed = 0;
  for (const id of ids) {
    try {
      await runWithTenant(id, 'job', () => fn(id));
    } catch (err) {
      failed += 1;
      console.error(`[alto-people/api] job ${name} failed for tenant ${id}:`, err);
    }
  }
  return { ran: ids.length, failed };
}

/** Wrap a job's body so each timer tick runs it per tenant. */
export function tenantJob(name: string, fn: () => Promise<unknown> | unknown): () => Promise<TenantJobRun> {
  return () => runForEachTenant(name, () => fn());
}

/** Wrap a platform-wide job so each tick runs under the audited platform scope. */
export function platformJob<T>(_name: string, fn: () => Promise<T> | T): () => Promise<T> {
  return () => Promise.resolve(withPlatformScope(fn));
}
