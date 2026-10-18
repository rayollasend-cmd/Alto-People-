import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The business structure, edited in one place: regions, which region a
 * store sits in, and its cost center — under the one rule that a store's
 * cost center sits under its region (so region-bound accounts keep it).
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function storeOf(clientName: string) {
  const client = await createClient(clientName);
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  return { client, store };
}

describe('regions and placement', () => {
  it('creates and renames a region, moves a store into it, and the chart follows', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { store } = await storeOf('Coastal');
    const a = await loginAs(hr.email);

    const made = await a.post('/org/structure/regions').send({ name: 'Panhandle' });
    expect(made.status).toBe(201);
    const regionId = made.body.region.id as string;
    expect((await a.patch(`/org/structure/regions/${regionId}`).send({ name: 'Florida Panhandle' })).status).toBe(200);

    // An empty region is on the chart before anything is in it.
    const before = (await a.get('/org/chart?view=field')).body.nodes as Array<{ id: string; name: string; parentId: string | null }>;
    expect(before.find((n) => n.id === `r:${regionId}`)?.name).toBe('Florida Panhandle');

    const placed = await a.put(`/org/structure/sites/${store.id}/placement`).send({ regionId });
    expect(placed.status).toBe(200);
    const row = await prisma.site.findUniqueOrThrow({ where: { id: store.id }, select: { regionId: true, orgUnit: { select: { type: true, legacyRegionId: true } } } });
    expect(row.regionId).toBe(regionId);
    expect(row.orgUnit).toMatchObject({ type: 'REGION', legacyRegionId: regionId });

    const after = (await a.get('/org/chart?view=field')).body.nodes as Array<{ id: string; parentId: string | null }>;
    const client = after.find((n) => n.parentId === `r:${regionId}`)!;
    expect(after.find((n) => n.id === `s:${store.id}`)!.parentId).toBe(client.id);

    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'site.placed', entityId: store.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'region.created', entityId: regionId } })).toBe(1);
  });

  it('a cost center must sit under the store’s region; moving region clears one that doesn’t', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { store } = await storeOf('Coastal');
    const a = await loginAs(hr.email);
    const north = (await a.post('/org/structure/regions').send({ name: 'North' })).body.region.id as string;
    const south = (await a.post('/org/structure/regions').send({ name: 'South' })).body.region.id as string;
    await a.put(`/org/structure/sites/${store.id}/placement`).send({ regionId: north });
    const northUnit = await prisma.orgUnit.findFirstOrThrow({ where: { legacyRegionId: north } });

    const loose = (await a.post('/admin/org-units').send({ type: 'COST_CENTER', name: 'Loose CC', glCode: '6000' })).body.unit.id as string;
    const under = (await a.post('/admin/org-units').send({ type: 'COST_CENTER', name: 'North CC', glCode: '6100', parentId: northUnit.id })).body.unit.id as string;

    const refused = await a.put(`/org/structure/sites/${store.id}/placement`).send({ orgUnitId: loose });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('outside_region');
    expect((await a.put(`/org/structure/sites/${store.id}/placement`).send({ orgUnitId: under })).status).toBe(200);

    const details = await a.get(`/org/structure/sites/${store.id}`);
    expect(details.body.site.costCenter).toMatchObject({ name: 'North CC', glCode: '6100' });
    const opts = await a.get('/org/structure/options');
    expect(opts.body.costCenters.find((c: { id: string }) => c.id === under).regionId).toBe(north);

    const moved = await a.put(`/org/structure/sites/${store.id}/placement`).send({ regionId: south });
    expect(moved.body.costCenterCleared).toBe(true);
    expect((await a.get(`/org/structure/sites/${store.id}`)).body.site.costCenter).toBeNull();
  });

  it('retiring a region leaves its stores, unplaced', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { store } = await storeOf('Coastal');
    const a = await loginAs(hr.email);
    const r = (await a.post('/org/structure/regions').send({ name: 'Gone soon' })).body.region.id as string;
    await a.put(`/org/structure/sites/${store.id}/placement`).send({ regionId: r });
    expect((await a.delete(`/org/structure/regions/${r}`)).status).toBe(204);
    const row = await prisma.site.findUniqueOrThrow({ where: { id: store.id }, select: { regionId: true, orgUnitId: true, deletedAt: true } });
    expect(row).toMatchObject({ regionId: null, orgUnitId: null, deletedAt: null });
  });

  it('a site-bound account can cost its own store but not move stores, add regions, or read another site', async () => {
    const { store: mine } = await storeOf('Mine');
    const { store: theirs } = await storeOf('Theirs');
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops@example.com' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [mine.id] } });
    const cc = await prisma.orgUnit.create({ data: { type: 'COST_CENTER', name: 'CC', path: '' } });
    await prisma.orgUnit.update({ where: { id: cc.id }, data: { path: `/${cc.id}` } });
    const a = await loginAs(ops.email);

    expect((await a.post('/org/structure/regions').send({ name: 'Mine now' })).status).toBe(403);
    expect((await a.put(`/org/structure/sites/${mine.id}/placement`).send({ regionId: null })).status).toBe(403);
    expect((await a.put(`/org/structure/sites/${mine.id}/placement`).send({ orgUnitId: cc.id })).status).toBe(200);
    expect((await a.get(`/org/structure/sites/${theirs.id}`)).status).toBe(404);
    expect((await a.put(`/org/structure/sites/${theirs.id}/placement`).send({ orgUnitId: cc.id })).status).toBe(404);
  });

  it('only people who manage the org can change structure', async () => {
    const { store } = await storeOf('Coastal');
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'fin@example.com' });
    const a = await loginAs(fin.email);
    expect((await a.get('/org/structure/options')).status).toBe(200);
    expect((await a.post('/org/structure/regions').send({ name: 'Nope' })).status).toBe(403);
    expect((await a.put(`/org/structure/sites/${store.id}/placement`).send({ regionId: null })).status).toBe(403);
  });
});

describe('sites', () => {
  it('adds a property of your own into a region, and a store for a client', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const client = await createClient('Coastal');
    const a = await loginAs(hr.email);
    const r = (await a.post('/org/structure/regions').send({ name: 'Gulf' })).body.region.id as string;

    const own = await a.post('/org/structure/sites').send({ name: 'Head office', type: 'OFFICE', regionId: r });
    expect(own.status).toBe(201);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: own.body.site.id } })).regionId).toBe(r);

    const forClient = await a.post('/org/structure/sites').send({ name: 'Beach 9', clientId: client.id });
    expect(forClient.status).toBe(201);
    // A workforce provider's new site is a store unless it says otherwise.
    expect(forClient.body.site).toMatchObject({ type: 'STORE', clientId: client.id });
  });

  it('a client’s store is read-only in Sites: identity edits go through the client', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { store } = await storeOf('Coastal');
    const a = await loginAs(hr.email);
    const refused = await a.patch(`/admin/sites/${store.id}`).send({ name: 'Renamed here' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('client_store');
    // Its kind of site is ours to classify; the client's page has no field for it.
    const retyped = await a.patch(`/admin/sites/${store.id}`).send({ type: 'PROPERTY' });
    expect(retyped.status).toBe(200);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: store.id } })).type).toBe('PROPERTY');

    const own = await a.post('/admin/sites').send({ name: 'Warehouse 2' });
    expect(own.status).toBe(201);
    expect(own.body.site.type).toBe('STORE');
    expect((await a.patch(`/admin/sites/${own.body.site.id}`).send({ name: 'Warehouse Two' })).status).toBe(200);
  });

  it('a direct employer’s department needs no client, and belongs to the tenant', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr-dept@example.com' });
    const a = await loginAs(hr.email);
    const made = await a.post('/org/departments').send({ clientId: null, name: 'Housekeeping' });
    expect(made.status).toBe(201);
    const row = await prisma.department.findUniqueOrThrow({ where: { id: made.body.id } });
    expect(row.clientId).toBeNull();
    expect(row.tenantId).not.toBeNull();
    expect((await a.post('/org/departments').send({ clientId: '00000000-0000-4000-8000-000000000123', name: 'Ghost' })).status).toBe(404);
  });
});
