import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Brief 2-3, step 1 — the audit floor's request-scoped flag.
 *
 * The floor middleware (middleware/auditFloor.ts) writes one row for every
 * data-changing request and every export, unless the request already wrote
 * its own, richer audit row. Every audit writer marks the request here:
 * enqueueAudit and recordCriticalAudit synchronously (a fire-and-forget
 * insert may not have reached Prisma yet when the response ends), the
 * Prisma extension for any direct `auditLog.create`, and the agent API's
 * finish-time recorder, which logs every /agent/v1 call itself.
 *
 * No imports: db.ts reads this module, so it must not reach db.ts back.
 */
export interface AuditRequestState {
  audited: boolean;
  /** Brief 2-3 step 4: who is acting, for rows written below the route (db.ts). */
  actorUserId?: string | null;
  requestId?: string | null;
}

export const auditRequestStore = new AsyncLocalStorage<AuditRequestState>();

/** This request has (or will have) its own audit row; the floor stands down. */
export function markRequestAudited(): void {
  const state = auditRequestStore.getStore();
  if (state) state.audited = true;
}

/**
 * Brief 2-3 step 4: audit rows db.ts writes on its own (the masked
 * before/after of a sensitive update). Never awaited on the write's path
 * (inside a transaction that already holds the tenant's chain lock it
 * would wait on itself); tracked here so tests' flushPendingAudits sees them.
 */
export const sideAuditWrites = new Set<Promise<unknown>>();
export function trackSideAudit(p: Promise<unknown>): void {
  const tracked = p.finally(() => sideAuditWrites.delete(tracked));
  sideAuditWrites.add(tracked);
}
