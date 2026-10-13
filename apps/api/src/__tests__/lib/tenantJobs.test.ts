import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { ALTO_TENANT_ID, onPlatformScope, tenantContext } from '../../lib/tenant.js';
import { activeTenantIds, platformJob, resetTenantCache, runForEachTenant, tenantJob } from '../../lib/tenantJobs.js';
import { resetTenantObservations, tenantObservations } from '../../lib/tenantGuard.js';
import { sweepDeactivatedUsers } from '../../lib/accessCleanup.js';

/**
 * Brief 2-1b step 0 — timed jobs run per tenant.
 */

const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
  resetTenantCache();
  resetTenantObservations();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('runForEachTenant', () => {
  it('runs the body once per active tenant inside that tenant, oldest first, and a failure does not stop the next', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    await prisma.tenant.create({ data: { slug: 'paused', name: 'Paused', status: 'SUSPENDED' } });
    expect(await activeTenantIds()).toEqual([ALTO_TENANT_ID, T2]);

    const seen: string[] = [];
    const r = await runForEachTenant('test', async (id) => {
      seen.push(`${id}=${tenantContext()?.tenantId}/${tenantContext()?.source}`);
      if (id === ALTO_TENANT_ID) throw new Error('boom');
    });
    expect(r).toEqual({ ran: 2, failed: 1, skipped: 0 });
    expect(seen).toEqual([`${ALTO_TENANT_ID}=${ALTO_TENANT_ID}/job`, `${T2}=${T2}/job`]);
  });

  it('a wrapped job writes under the tenant and leaves no no-context observation; a platform job opens the platform scope', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.user.update({ where: { id: user.id }, data: { deactivatedAt: new Date(Date.now() - 40 * 86_400_000), purgeAfter: new Date(Date.now() - 10 * 86_400_000) } });
    resetTenantObservations();
    const job = tenantJob('accessCleanup', () => sweepDeactivatedUsers());
    expect(await job()).toEqual({ ran: 1, failed: 0, skipped: 0 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).not.toBeNull();
    expect(tenantObservations().filter((o) => o.kind === 'no_context' && o.model === 'User')).toEqual([]);

    const opened: string[] = [];
    onPlatformScope((ctx) => opened.push(ctx.source));
    const pj = platformJob('usageTracker', () => tenantContext()?.platform ?? false);
    expect(await pj()).toBe(true);
    expect(opened).toEqual(['platform']);
  });
});
