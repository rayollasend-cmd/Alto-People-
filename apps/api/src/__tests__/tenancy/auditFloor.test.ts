import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { routePattern } from '../../middleware/auditFloor.js';

/**
 * Brief 2-3, step 1 — the audit floor.
 *
 *   Every data-changing request and every export leaves exactly one audit
 *   row of its own: the route's domain row when it writes one, otherwise
 *   the floor's `http.<method>` / `http.export` row with actor, tenant,
 *   route, target and outcome, never a body value. The database refuses
 *   to edit, delete or truncate the table, and a tenant's admin reads only
 *   that tenant's rows.
 */

const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

type Agent = Awaited<ReturnType<typeof loginAs>>;

/** The audit rows a request left, written by this actor after `since`. */
async function rowsOf(actorUserId: string, since: Date) {
  await flushPendingAudits();
  return prisma.auditLog.findMany({ where: { actorUserId, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } });
}

async function oneRequest(actorUserId: string, send: () => Promise<{ status: number }>) {
  const since = new Date(Date.now() - 5);
  const res = await send();
  const rows = await rowsOf(actorUserId, since);
  const floor = rows.filter((r) => r.action.startsWith('http.'));
  const domain = rows.filter((r) => !r.action.startsWith('http.'));
  return { res, rows, floor, domain };
}

describe('the floor', () => {
  it('folds a request path into a route pattern and keeps the ids it named', () => {
    const id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
    expect(routePattern(`/api/scheduling/shifts/${id}/unassign?x=1`)).toEqual({ route: '/scheduling/shifts/:id/unassign', ids: [id] });
    expect(routePattern('/payroll/runs/42')).toEqual({ route: '/payroll/runs/:id', ids: [] });
  });

  it('every write and every export leaves one row: the domain row when there is one, otherwise the floor row', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin: Agent = await loginAs(agent(), hr.email);

    // A write with no domain audit of its own: the floor row, with names, not values.
    const pins = await oneRequest(hr.id, () => admin.put('/auth/me/nav-pins').send({ pinned: ['scheduling'] }));
    expect(pins.floor, JSON.stringify(pins.rows)).toHaveLength(1);
    expect(pins.floor[0]).toMatchObject({ action: 'http.put', entityType: 'HttpRequest', tenantId: ALTO_TENANT_ID, actorUserId: hr.id });
    expect(pins.floor[0]!.metadata).toMatchObject({ method: 'PUT', route: '/auth/me/nav-pins', status: pins.res.status, fields: ['pinned'], via: 'session' });
    expect(JSON.stringify(pins.floor[0]!.metadata)).not.toContain('scheduling');

    // A failed write is recorded too, with its outcome.
    const bad = await oneRequest(hr.id, () => admin.put('/auth/me/nav-pins').send({ pinned: 'not-a-list', ssn: '123-45-6789' }));
    expect(bad.res.status).toBe(400);
    expect(bad.floor).toHaveLength(1);
    expect(bad.floor[0]!.metadata).toMatchObject({ status: 400, fields: ['pinned', 'ssn'] });
    expect(JSON.stringify(bad.floor[0]!.metadata)).not.toContain('123-45-6789');

    // Writes across other routers: never zero rows, never a floor row beside a domain row.
    const writes: Array<() => Promise<{ status: number }>> = [
      () => admin.post('/admin/org-units').send({ type: 'REGION', name: 'Gulf Coast' }),
      () => admin.post('/admin/sites').send({ name: 'The Grand Hotel', state: 'FL' }),
      () => admin.patch('/admin/org/settings').send({ orgName: 'Alto HR' }),
      () => admin.patch('/auth/me/language').send({ language: 'es' }),
    ];
    for (const send of writes) {
      const r = await oneRequest(hr.id, send);
      expect(r.rows.length, JSON.stringify(r.rows.map((x) => x.action))).toBeGreaterThanOrEqual(1);
      expect(r.floor).toHaveLength(r.domain.length === 0 ? 1 : 0);
    }

    // An export: the audit CSV writes no domain row, so the floor records it.
    const csv = await oneRequest(hr.id, () => admin.get('/audit/logs.csv'));
    expect(csv.res.status).toBe(200);
    expect(csv.floor).toHaveLength(1);
    expect(csv.floor[0]).toMatchObject({ action: 'http.export', entityId: '/audit/logs.csv' });
    expect(csv.floor[0]!.metadata).toMatchObject({ method: 'GET', status: 200, contentType: 'text/csv' });

    // An ordinary read writes nothing.
    const read = await oneRequest(hr.id, () => admin.get('/admin/org-units'));
    expect(read.res.status).toBe(200);
    expect(read.rows).toEqual([]);
  });
});

describe('the table cannot be altered', () => {
  it('refuses an edit (the tenant included), a delete and a truncate, directly or by cascade', async () => {
    const row = await prisma.auditLog.create({ data: { action: 'test.row', entityType: 'Test', entityId: 'x', tenantId: ALTO_TENANT_ID } });
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { tenantId: T2 } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'test.edited' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')).rejects.toThrow(/cannot be truncated/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE')).rejects.toThrow(/cannot be truncated/);
    expect(await prisma.auditLog.count({ where: { id: row.id } })).toBe(1);
  });
});

describe('a tenant reads only its own trail', () => {
  it("tenant two's admin sees none of tenant one's rows, in the viewer or the CSV", async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const mine = await prisma.auditLog.create({ data: { action: 'test.tenant_one', entityType: 'Test', entityId: 'one', tenantId: ALTO_TENANT_ID } });
    const theirs = await prisma.auditLog.create({ data: { action: 'test.tenant_two', entityType: 'Test', entityId: 'two', tenantId: T2 } });

    const { user: two } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: two.id }, data: { tenantId: T2 } });
    const a2 = await loginAs(agent(), two.email);
    const list = await a2.get('/audit/logs');
    expect(list.status).toBe(200);
    const ids = (list.body.entries as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(theirs.id);
    expect(ids).not.toContain(mine.id);
    const csv = await a2.get('/audit/logs.csv');
    expect(csv.text).not.toContain(mine.id);

    const { user: one } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a1 = await loginAs(agent(), one.email);
    const ids1 = ((await a1.get('/audit/logs')).body.entries as Array<{ id: string }>).map((e) => e.id);
    expect(ids1).toContain(mine.id);
    expect(ids1).not.toContain(theirs.id);
  });
});
