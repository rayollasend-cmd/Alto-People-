import * as Sentry from '@sentry/node';

/**
 * Brief 2-1 §9.6: Sentry knows whose request or job an error came from.
 *
 *   A request runs in its own Sentry isolation scope (the SDK's HTTP
 *   instrumentation forks one per incoming request), so a tag set on it
 *   stays with that request — its errors and its transaction — and never
 *   bleeds into the next. A job tick gets its own scope from
 *   `withTenantTelemetry`. lib/sentry.ts also stamps the tag from the live
 *   tenant context at send time, for anything captured outside both.
 *
 *   Kept free of lib/tenant.ts and config/env.ts on purpose: lib/tenant.ts
 *   imports this, and it must stay cheap to import from anywhere.
 *
 *   No-ops while Sentry is off (no DSN): there is no per-request scope to
 *   tag then, and nothing is sent.
 */
export function tagTenantScope(tenantId: string, source: string): void {
  if (!Sentry.isInitialized()) return;
  const scope = Sentry.getIsolationScope();
  scope.setTag('tenant', tenantId);
  scope.setTag('tenant_source', source);
}

/** Run `fn` (a job's per-tenant body) in its own isolation scope tagged with the tenant. */
export function withTenantTelemetry<T>(tenantId: string, source: string, fn: () => T): T {
  if (!Sentry.isInitialized()) return fn();
  return Sentry.withIsolationScope((scope) => {
    scope.setTag('tenant', tenantId);
    scope.setTag('tenant_source', source);
    return fn();
  });
}
