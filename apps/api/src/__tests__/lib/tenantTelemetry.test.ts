import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

/**
 * Brief 2-1 §9.6: Sentry carries the tenant — on the request's isolation
 * scope (tenantMiddleware, and adoptTenant for an anonymous request), on a
 * fresh scope per job tick (runForEachTenant, platformJob), and stamped at
 * send time from the live context for anything else.
 */

const sentry = vi.hoisted(() => {
  type FakeScope = { tags: Record<string, string>; setTag(k: string, v: string): void };
  const make = (): FakeScope => ({ tags: {}, setTag(k, v) { this.tags[k] = v; } });
  return { make, request: make(), forked: [] as Array<{ tags: Record<string, string> }> };
});

vi.mock('@sentry/node', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@sentry/node')>();
  return {
    ...orig,
    isInitialized: () => true,
    getIsolationScope: () => sentry.request,
    withIsolationScope: (cb: (s: unknown) => unknown) => {
      const scope = sentry.make();
      sentry.forked.push(scope);
      return cb(scope);
    },
  };
});

const { prisma, truncateAll } = await import('../../../test/db.js');
const { ALTO_TENANT_ID, adoptTenant, runWithTenant, tenantContext, tenantMiddleware } = await import('../../lib/tenant.js');
const { platformJob, resetTenantCache, runForEachTenant } = await import('../../lib/tenantJobs.js');
const { stampTenant } = await import('../../lib/sentry.js');

const T2 = '22222222-2222-4222-8222-222222222222';

function runMiddleware(user: { tenantId: string } | undefined, inside: () => void): void {
  tenantMiddleware({ user } as unknown as Request, {} as Response, (() => inside()) as NextFunction);
}

beforeEach(() => {
  sentry.request = sentry.make();
  sentry.forked.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('request scope', () => {
  it('a signed-in request tags its isolation scope with the user\'s tenant', () => {
    runMiddleware({ tenantId: T2 }, () => undefined);
    expect(sentry.request.tags).toEqual({ tenant: T2, tenant_source: 'session' });
  });

  it('an anonymous request starts as the default tenant and moves with the tenant it adopts', () => {
    runMiddleware(undefined, () => {
      expect(sentry.request.tags).toEqual({ tenant: ALTO_TENANT_ID, tenant_source: 'default' });
      expect(adoptTenant(T2)).toBe(true);
    });
    expect(sentry.request.tags.tenant).toBe(T2);
  });
});

describe('job ticks', () => {
  beforeEach(async () => {
    await truncateAll();
    resetTenantCache();
  });

  it('each tenant\'s run gets its own scope tagged with that tenant, and the body runs inside it', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const seen: string[] = [];
    await runForEachTenant('telemetry', (id) => {
      seen.push(`${id}:${sentry.forked.at(-1)?.tags.tenant}`);
    });
    expect(sentry.forked.map((s) => s.tags)).toEqual([
      { tenant: ALTO_TENANT_ID, tenant_source: 'job' },
      { tenant: T2, tenant_source: 'job' },
    ]);
    expect(seen).toEqual([`${ALTO_TENANT_ID}:${ALTO_TENANT_ID}`, `${T2}:${T2}`]);
    // The request's scope is never touched by a job.
    expect(sentry.request.tags).toEqual({});
  });

  it('a platform job is tagged as the platform', async () => {
    expect(await platformJob('telemetry', () => tenantContext()?.platform)()).toBe(true);
    expect(sentry.forked.map((s) => s.tags)).toEqual([{ tenant: 'platform', tenant_source: 'platform' }]);
  });
});

describe('stampTenant (beforeSend)', () => {
  it('stamps the live tenant on an untagged event and keeps a tag already set', async () => {
    const stamped = await runWithTenant(T2, 'api-key', () => stampTenant({ tags: {} as Record<string, unknown> }));
    expect(stamped.tags).toEqual({ tenant: T2, tenant_source: 'api-key' });
    const kept = await runWithTenant(T2, 'api-key', () => stampTenant({ tags: { tenant: ALTO_TENANT_ID } as Record<string, unknown> }));
    expect(kept.tags).toEqual({ tenant: ALTO_TENANT_ID });
    expect(stampTenant({} as { tags?: Record<string, unknown> }).tags).toBeUndefined();
  });
});
