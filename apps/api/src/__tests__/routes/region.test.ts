import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The region command center: a region account sees exactly its region's
 * stores (across clients), on the store site's own numbers, can open any
 * of them and none outside; admins manage regions; the rest of the
 * portal stays fail-closed for an account with no client.
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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

const HOUR = 3_600_000;

async function seedRegion() {
  // Two clients, one store each, both in the Panhandle region; a third
  // client's store outside it.
  const clientA = await createClient('Walmart 218');
  const clientB = await createClient('Walmart 4411');
  const clientC = await createClient('Target 9');
  const [storeA] = await prisma.location.findMany({ where: { clientId: clientA.id } });
  const [storeB] = await prisma.location.findMany({ where: { clientId: clientB.id } });
  const [storeC] = await prisma.location.findMany({ where: { clientId: clientC.id } });
  const region = await prisma.region.create({ data: { name: 'Florida Panhandle' } });
  await prisma.location.updateMany({ where: { id: { in: [storeA!.id, storeB!.id] } }, data: { regionId: region.id } });
  const now = new Date();
  // Store A: target 3, one live shift with a punch, one open slot.
  await prisma.staffingTarget.create({ data: { locationId: storeA!.id, targetCount: 3, effectiveFrom: new Date('2020-01-01') } });
  const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const live = await prisma.shift.create({
    data: {
      clientId: clientA.id,
      locationId: storeA!.id,
      assignedAssociateId: maria.id,
      position: 'Stocker',
      startsAt: new Date(now.getTime() - HOUR),
      endsAt: new Date(now.getTime() + 3 * HOUR),
      status: 'ASSIGNED',
      publishedAt: now,
      acknowledgedAt: now,
    },
  });
  await prisma.timeEntry.create({
    data: { associateId: maria.id, clientId: clientA.id, locationId: storeA!.id, shiftId: live.id, clockInAt: new Date(now.getTime() - HOUR), status: 'ACTIVE' },
  });
  await prisma.shift.create({
    data: {
      clientId: clientA.id,
      locationId: storeA!.id,
      position: 'Cashier',
      startsAt: new Date(now.getTime() - HOUR),
      endsAt: new Date(now.getTime() + 3 * HOUR),
      status: 'OPEN',
      publishedAt: now,
    },
  });
  // Store C (outside the region) has a shift too — it must never appear.
  await prisma.shift.create({
    data: {
      clientId: clientC.id,
      locationId: storeC!.id,
      position: 'TargetOnlyPosition',
      startsAt: now,
      endsAt: new Date(now.getTime() + 4 * HOUR),
      status: 'OPEN',
      publishedAt: now,
    },
  });
  const { user: regionUser } = await createUser({ role: 'CLIENT_PORTAL' });
  await prisma.user.update({ where: { id: regionUser.id }, data: { regionId: region.id } });
  const dana = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  const { user: supA } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: clientA.id, associateId: dana.id });
  const { user: supC } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: clientC.id });
  return { region, clientA, clientB, clientC, storeA: storeA!, storeB: storeB!, storeC: storeC!, regionUser, supA, supC };
}

describe('the region command center', () => {
  it('shows a region account every store in its region and nothing outside it', async () => {
    const s = await seedRegion();
    const agent = await loginAs(s.regionUser.email);
    const res = await agent.get('/region/overview');
    expect(res.status).toBe(200);
    expect(res.body.region.name).toBe('Florida Panhandle');
    expect(res.body.preview).toBe(false);
    expect(res.body.totals.stores).toBe(2);
    const names = res.body.stores.map((x: { name: string }) => x.name);
    expect(names).toContain('Walmart 218');
    expect(names).toContain('Walmart 4411');
    expect(names).not.toContain('Target 9');
    // Store A is short (1 on the floor of 3 contracted, 1 slot open) and ranks first.
    const a = res.body.stores[0];
    expect(a.name).toBe('Walmart 218');
    expect(a.now).toMatchObject({ onFloor: 1, target: 3 });
    expect(a.now.short).toBeGreaterThan(0);
    expect(a.today).toMatchObject({ expected: 1, present: 1, open: 1 });
    expect(a.leads).toEqual({ onFloor: 0, total: 1 });
    expect(res.body.totals.onFloor).toBe(1);
    expect(res.body.totals.openToday).toBe(1);
    // Rate hygiene and tenant hygiene on the raw payload.
    const raw = JSON.stringify(res.body);
    for (const w of ['payRate', 'billRate', 'hourlyRate', 'TargetOnlyPosition', s.clientC.id]) expect(raw).not.toContain(w);

    // Drilling into a store in the region opens the store site; a store
    // outside it is refused; no store named is a 400, never the world.
    const drill = await agent.get(`/client-portal/overview?locationId=${s.storeB.id}`);
    expect(drill.status).toBe(200);
    expect(drill.body.store.id).toBe(s.storeB.id);
    expect(drill.body.client.id).toBe(s.clientB.id);
    expect((await agent.get(`/client-portal/overview?locationId=${s.storeC.id}`)).status).toBe(400);
    expect((await agent.get('/client-portal/overview')).status).toBe(400);
    expect((await agent.get(`/client-portal/day?locationId=${s.storeA.id}`)).status).toBe(200);
    // The shared clamps fail closed for an account with no client.
    expect((await agent.get(`/clients/${s.clientA.id}/locations`)).status).toBe(404);

    // Messaging: a region account reaches supervisors in its region and
    // the desks, never a supervisor outside it.
    const dir = await agent.get('/messages/directory');
    const ids = dir.body.people.map((p: { id: string }) => p.id);
    expect(ids).toContain(s.supA.id);
    expect(ids).not.toContain(s.supC.id);
    expect((await agent.post('/messages/conversations').send({ participantIds: [s.supA.id], body: 'hi' })).status).toBe(201);
    expect((await agent.post('/messages/conversations').send({ participantIds: [s.supC.id] })).status).toBe(403);
  });

  it('lets admins manage regions and preview a command center; store accounts stay out', async () => {
    const s = await seedRegion();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(hr.email);

    const list = await admin.get('/regions');
    expect(list.status).toBe(200);
    expect(list.body.regions[0].stores).toHaveLength(2);
    expect(list.body.unassigned.map((x: { name: string }) => x.name)).toEqual(['Target 9']);

    const created = await admin.post('/regions').send({ name: 'Gulf Coast', locationIds: [s.storeC.id] });
    expect(created.status).toBe(201);
    const preview = await admin.get(`/region/overview?regionId=${created.body.id}`);
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toBe(true);
    expect(preview.body.stores.map((x: { name: string }) => x.name)).toEqual(['Target 9']);
    expect((await admin.get('/region/overview')).status).toBe(400);

    // Reassign: moving store B to Gulf Coast takes it out of the Panhandle.
    expect((await admin.patch(`/regions/${created.body.id}`).send({ locationIds: [s.storeC.id, s.storeB.id] })).status).toBe(204);
    const panhandle = await (await loginAs(s.regionUser.email)).get('/region/overview');
    expect(panhandle.body.totals.stores).toBe(1);

    // Bind an account to a region from Users & access: client and store clear.
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: s.clientA.id });
    expect((await admin.patch(`/admin/users/${portal.id}`).send({ regionId: created.body.id })).status).toBe(204);
    const bound = await prisma.user.findUniqueOrThrow({ where: { id: portal.id } });
    expect(bound.regionId).toBe(created.body.id);
    expect(bound.clientId).toBeNull();
    expect((await admin.patch(`/admin/users/${portal.id}`).send({ regionId: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);

    // A store account has no command center; an associate has nothing here.
    const { user: storeMgr } = await createUser({ role: 'CLIENT_PORTAL', clientId: s.clientA.id });
    expect((await (await loginAs(storeMgr.email)).get('/region/overview')).status).toBe(403);
    expect((await (await loginAs(storeMgr.email)).get('/regions')).status).toBe(403);

    // Retiring a region unassigns its stores and unbinds its accounts.
    expect((await admin.delete(`/regions/${created.body.id}`)).status).toBe(204);
    expect((await prisma.location.findUniqueOrThrow({ where: { id: s.storeC.id } })).regionId).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: portal.id } })).regionId).toBeNull();
  });
});
