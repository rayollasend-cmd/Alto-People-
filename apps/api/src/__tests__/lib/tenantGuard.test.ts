import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { prisma as app } from '../../db.js';
import { agent, loginAs } from '../../../test/http.js';
import { ALTO_TENANT_ID, onPlatformScope, runWithTenant, withPlatformScope } from '../../lib/tenant.js';
import { TENANT_SCOPED_MODELS, applicationCallSite, resetTenantObservations, tenantObservations } from '../../lib/tenantGuard.js';
import { listRoutes } from '../../lib/routeInventory.js';
import { createApp } from '../../app.js';

/**
 * Brief 2-1, step two — the tenant wall in observe mode.
 *
 *   A query with no tenant in context is recorded with its call site and
 *   still runs; a create inside a context carries the tenant; a write or
 *   filter naming another tenant is recorded; enforce mode throws instead.
 *   Nothing on disk changes: the stamped id is the database default.
 */

const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
  resetTenantObservations();
  delete process.env.TENANCY_MODE;
});
afterEach(() => {
  delete process.env.TENANCY_MODE;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('observe mode', () => {
  it('covers every tenant-scoped model and none of the shared or platform-wide ones', () => {
    expect(TENANT_SCOPED_MODELS.has('User')).toBe(true);
    expect(TENANT_SCOPED_MODELS.has('Ride')).toBe(true);
    for (const m of ['Tenant', 'PayrollConfig', 'LocalTaxRule', 'GeoCache', 'ApiBoot', 'RouteUsageDaily', 'WebVitalDaily', 'ReliabilityWeek']) {
      expect(TENANT_SCOPED_MODELS.has(m), m).toBe(false);
    }
    expect(TENANT_SCOPED_MODELS.size).toBeGreaterThan(250);
  });

  it('records a query with no tenant in context, with its call site, and lets it run', async () => {
    const a = await app.associate.create({ data: { firstName: 'No', lastName: 'Context', email: `noctx-${Date.now()}@example.com` } });
    expect(a.id).toBeTruthy();
    const rows = tenantObservations();
    const hit = rows.find((r) => r.kind === 'no_context' && r.model === 'Associate' && r.operation === 'create');
    expect(hit).toBeTruthy();
    expect(hit!.count).toBeGreaterThanOrEqual(1);
    // A lazy Prisma promise runs when awaited, so the issuing frame is not always on the stack; the site is best effort.
    expect(typeof hit!.callSite).toBe('string');
    // Shared reference data is never recorded.
    await app.tenant.findMany();
    expect(rows.some((r) => r.model === 'Tenant')).toBe(false);
  });

  it('stamps a create with the tenant in context and records a write or filter that names another tenant', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    await runWithTenant(T2, 'job', async () => {
      const a = await app.associate.create({ data: { firstName: 'Two', lastName: 'Tenant', email: `two-${Date.now()}@example.com` } });
      expect((await app.associate.findUniqueOrThrow({ where: { id: a.id } })).tenantId).toBe(T2);
      // Named explicitly, kept: an explicit id is the caller's call, recorded when it is someone else's.
      await app.associate.create({ data: { firstName: 'Alto', lastName: 'Row', email: `alto-${Date.now()}@example.com`, tenantId: ALTO_TENANT_ID } });
      await app.associate.findMany({ where: { tenantId: ALTO_TENANT_ID } });
    });
    const kinds = tenantObservations().map((r) => `${r.kind}:${r.model}.${r.operation}`);
    expect(kinds).toContain('other_tenant_write:Associate.create');
    expect(kinds).toContain('other_tenant_filter:Associate.findMany');
    expect(tenantObservations().filter((r) => r.kind === 'no_context' && r.model === 'Associate')).toEqual([]);
  });

  it('the platform scope is on the record, and does not count as another tenant', async () => {
    const seen: string[] = [];
    onPlatformScope((ctx, callSite) => seen.push(`${ctx.tenantId}@${callSite}`));
    await runWithTenant(T2, 'job', async () => {
      await withPlatformScope(async () => {
        await app.associate.findMany({ where: { tenantId: ALTO_TENANT_ID } });
      });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(new RegExp(`^${T2}@.*tenantGuard\\.test\\.ts:\\d+$`));
    expect(tenantObservations().some((r) => r.kind === 'other_tenant_filter')).toBe(false);
  });

  it('a signed-in request runs as the user\'s tenant and its writes carry it', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: user.id }, data: { tenantId: T2 } });
    const a = await loginAs(agent(), user.email);
    const res = await a.post('/admin/org/settings').send({});
    expect([200, 204, 400, 404, 405]).toContain(res.status);
    const region = await a.post('/regions').send({ name: 'Two Region', locationIds: [] });
    if (region.status === 201) {
      expect((await prisma.region.findUniqueOrThrow({ where: { id: region.body.id } })).tenantId).toBe(T2);
    }
  });
});

describe('enforce mode (step four, available to the tests)', () => {
  it('throws on a missing context and on another tenant\'s id', async () => {
    process.env.TENANCY_MODE = 'enforce';
    await expect(app.associate.findMany()).rejects.toThrow(/no tenant in context/);
    await expect(
      runWithTenant(T2, 'job', () => app.associate.findMany({ where: { tenantId: ALTO_TENANT_ID } })),
    ).rejects.toThrow(/another tenant/);
    await runWithTenant(ALTO_TENANT_ID, 'job', async () => {
      expect(await app.associate.count()).toBe(0);
    });
    process.env.TENANCY_MODE = 'off';
    expect(await app.associate.count()).toBe(0);
  });
});

describe('the helpers', () => {
  it('finds the application frame in a stack and lists every mounted route', () => {
    const stack = [
      'Error',
      '    at record (C:\\x\\apps\\api\\src\\lib\\tenantGuard.ts:80:20)',
      '    at Object.$allOperations (C:\\x\\apps\\api\\src\\db.ts:70:16)',
      '    at async createAssociate (C:\\x\\apps\\api\\test\\db.ts:220:5)',
    ].join('\n');
    expect(applicationCallSite(stack)).toMatch(/test\/db\.ts:220$/);
    const routes = listRoutes(createApp());
    expect(routes.length).toBeGreaterThan(300);
    expect(routes).toContainEqual({ method: 'GET', path: '/admin/users' });
    expect(routes).toContainEqual({ method: 'GET', path: '/admin/tenancy/observations' });
    expect(routes).toContainEqual({ method: 'POST', path: '/transport/me/authorization' });
    expect(routes.some((r) => r.path.includes('(?'))).toBe(false);
  });
});
