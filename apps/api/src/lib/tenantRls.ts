import { Prisma } from '@prisma/client';
import { tenantContext } from './tenant.js';
import { resolvesUnbound } from './tenantGuard.js';

/**
 * The database wall, step four of Brief 2-1 (§9.5): row-level security.
 *
 *   Migration 20270128190100_tenancy_rls enables (does not force) a policy
 *   on every tenant-keyed table: a row is visible and writable when its
 *   tenantId equals the transaction's `app.tenant_id`, or when the
 *   transaction opened the audited platform scope (`app.platform_scope`).
 *   The table owner bypasses a policy that is not forced, so nothing
 *   changes while the app connects as the owner.
 *
 *   TENANCY_RLS=on (default off) makes every query carry its tenant: a
 *   query outside a transaction runs inside a two-statement batch
 *   (set_config, then the query); an interactive or batch transaction sets
 *   it once, first. set_config(..., true) is transaction-local, so it lives
 *   and dies with the transaction and is safe behind a transaction-mode
 *   pooler. Switch it on together with the non-owner role (the runbook:
 *   docs/runbooks/tenancy-rls-cutover.md); on its own, as the owner, it only
 *   costs the extra statement.
 */

export function rlsEnabled(): boolean {
  return process.env.TENANCY_RLS === 'on';
}

export interface RlsSettings {
  /** '' when there is no tenant: the policy then matches no row. */
  tenantId: string;
  platform: boolean;
}

/**
 * What the database is told for the current context. It mirrors the
 * application wall (lib/tenantGuard):
 *   - a request, job or script runs as its tenant;
 *   - withPlatformScope / withIdentityScope open the platform scope;
 *   - an anonymous request's first single-record lookup (a token, a slug)
 *     is not narrowed, so it can find the row it adopts its tenant from;
 *   - outside any context, TENANCY_UNSCOPED=platform (fixtures, one-off
 *     scripts) sees everything, and anything else sees nothing.
 */
export function rlsSettings(operation?: string): RlsSettings {
  const ctx = tenantContext();
  if (!ctx) return { tenantId: '', platform: process.env.TENANCY_UNSCOPED === 'platform' };
  return { tenantId: ctx.tenantId, platform: ctx.platform || (operation !== undefined && resolvesUnbound(ctx, operation)) };
}

/** The statement that hands the settings to the transaction it runs in. */
export function setConfigSql(s: RlsSettings): Prisma.Sql {
  return Prisma.sql`SELECT set_config('app.tenant_id', ${s.tenantId}, true), set_config('app.platform_scope', ${s.platform ? 'on' : 'off'}, true)`;
}
