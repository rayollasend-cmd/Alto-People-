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
 * Deactivated and separated associates stayed on store schedules: the
 * client-scoped roster only filtered deleted rows and disabled logins (a
 * kiosk-only associate has no login), deactivation left DRAFT assignments
 * in place, separation released nothing, and nothing refused assigning
 * them. And "on the floor now" counted only punches matched to an
 * assigned shift, so a full floor of walk-ins and covers read 0.
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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const inDays = (d: number, h = 0) => new Date(Date.now() + (d * 24 + h) * 3_600_000);

async function atStore(name: string, clientId: string) {
  const a = await createAssociate({ firstName: name, lastName: 'Worker' });
  const location = await prisma.location.findFirstOrThrow({ where: { clientId } });
  await prisma.associateAssignment.create({
    data: { associateId: a.id, locationId: location.id, startedAt: new Date('2026-01-01') },
  });
  return a;
}

async function seed() {
  const client = await createClient('Front Beach');
  const { user: supUser } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
  const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { client, sup: await loginAs(supUser.email), hr: await loginAs(hrUser.email) };
}

describe('people who no longer work here come off the schedule', () => {
  it('deactivation releases future published AND draft assignments; history stays', async () => {
    const { client, hr } = await seed();
    const gone = await atStore('Gone', client.id);
    const [past, published, draft] = await Promise.all([
      prisma.shift.create({
        data: { clientId: client.id, position: 'Server', startsAt: inDays(-2), endsAt: inDays(-2, 8), status: 'COMPLETED', assignedAssociateId: gone.id },
      }),
      prisma.shift.create({
        data: { clientId: client.id, position: 'Server', startsAt: inDays(2), endsAt: inDays(2, 8), status: 'ASSIGNED', assignedAssociateId: gone.id, publishedAt: new Date() },
      }),
      prisma.shift.create({
        data: { clientId: client.id, position: 'Server', startsAt: inDays(9), endsAt: inDays(9, 8), status: 'DRAFT', assignedAssociateId: gone.id },
      }),
    ]);

    const res = await hr.post(`/org/associates/${gone.id}/deactivate`).send({ reason: 'Two-week leave' });
    expect(res.status).toBe(200);

    const after = await prisma.shift.findMany({ where: { id: { in: [past.id, published.id, draft.id] } } });
    const byId = new Map(after.map((s) => [s.id, s]));
    expect(byId.get(past.id)!.assignedAssociateId).toBe(gone.id);
    expect(byId.get(published.id)).toMatchObject({ status: 'OPEN', assignedAssociateId: null });
    expect(byId.get(draft.id)).toMatchObject({ status: 'DRAFT', assignedAssociateId: null });
  });

  it('completing a separation releases their future shifts too', async () => {
    const { client, hr } = await seed();
    const leaving = await atStore('Leaving', client.id);
    const future = await prisma.shift.create({
      data: { clientId: client.id, position: 'Server', startsAt: inDays(3), endsAt: inDays(3, 8), status: 'ASSIGNED', assignedAssociateId: leaving.id, publishedAt: new Date() },
    });
    const created = await hr.post('/separations').send({
      associateId: leaving.id,
      reason: 'VOLUNTARY_PERSONAL',
      lastDayWorked: new Date().toISOString().slice(0, 10),
    });
    expect(created.status).toBe(201);
    await hr.post(`/separations/${created.body.id}/advance`);
    expect((await hr.post(`/separations/${created.body.id}/advance`)).status).toBe(200);

    expect(await prisma.shift.findUniqueOrThrow({ where: { id: future.id } })).toMatchObject({
      status: 'OPEN',
      assignedAssociateId: null,
    });
  });

  it("the store roster drops deactivated and separated people — kiosk-only ones included", async () => {
    const { client, sup } = await seed();
    const here = await atStore('Here', client.id);
    const deactivated = await atStore('Deactivated', client.id); // no login at all
    const separated = await atStore('Separated', client.id);
    await prisma.associate.update({ where: { id: deactivated.id }, data: { deactivatedAt: new Date() } });
    await prisma.associate.update({ where: { id: separated.id }, data: { separatedAt: new Date() } });

    const res = await sup.get('/scheduling/associates');
    expect(res.status).toBe(200);
    const ids = (res.body.associates as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual([here.id]);
  });

  it('refuses to put someone inactive on a shift, one at a time or in bulk', async () => {
    const { client, sup } = await seed();
    const gone = await atStore('Gone', client.id);
    const here = await atStore('Here', client.id);
    await prisma.associate.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });
    const open = await prisma.shift.create({
      data: { clientId: client.id, position: 'Server', startsAt: inDays(2), endsAt: inDays(2, 8), status: 'OPEN', publishedAt: new Date() },
    });

    const assign = await sup.post(`/scheduling/shifts/${open.id}/assign`).send({ associateId: gone.id });
    expect(assign.status).toBe(409);
    expect(assign.body.error.code).toBe('associate_inactive');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: open.id } })).assignedAssociateId).toBeNull();

    const bulk = await sup.post('/scheduling/shifts/bulk').send({
      clientId: client.id,
      position: 'Server',
      startsAt: inDays(4).toISOString(),
      endsAt: inDays(4, 8).toISOString(),
      associateIds: [gone.id, here.id],
    });
    expect(bulk.status).toBe(201);
    expect(bulk.body.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ associateId: gone.id, reason: 'inactive' })]),
    );
    expect(
      await prisma.shift.count({ where: { assignedAssociateId: gone.id } }),
    ).toBe(0);
    expect(await prisma.shift.count({ where: { assignedAssociateId: here.id } })).toBe(1);
  });
});

describe('"on the floor now" counts everyone clocked in', () => {
  it('a walk-in with no assigned shift is on the floor, and in the day payload', async () => {
    const { client, sup } = await seed();
    const scheduled = await atStore('Scheduled', client.id);
    const walkIn = await atStore('WalkIn', client.id);
    const shift = await prisma.shift.create({
      data: { clientId: client.id, position: 'Server', startsAt: inDays(0, -1), endsAt: inDays(0, 6), status: 'ASSIGNED', assignedAssociateId: scheduled.id, publishedAt: new Date() },
    });
    await prisma.timeEntry.createMany({
      data: [
        { associateId: scheduled.id, clientId: client.id, shiftId: shift.id, clockInAt: inDays(0, -1), status: 'ACTIVE' },
        { associateId: walkIn.id, clientId: client.id, clockInAt: inDays(0, -0.5), status: 'ACTIVE' },
      ],
    });

    const day = await sup.get('/client-portal/day');
    expect(day.status).toBe(200);
    // The roster still reads per shift — one matched punch …
    expect(day.body.summary.onFloor).toBe(1);
    // … but the floor right now is both of them.
    const live = (day.body.onFloorNow as Array<{ associateId: string }>).map((e) => e.associateId).sort();
    expect(live).toEqual([scheduled.id, walkIn.id].sort());

    // "Today" in the viewer's zone can be the org's yesterday or tomorrow
    // (a Pacific store at 9:30 PM is already on the Eastern 18th) — the
    // neighbouring days carry the live list too; older days never do.
    // Step from the store's own today (the payload's), not the UTC date —
    // from 8 PM to midnight Eastern, UTC is already a day ahead.
    const storeToday = day.body.today as string;
    const dayKey = (offset: number) => {
      const [y, m, d] = storeToday.split('-').map(Number);
      return new Date(Date.UTC(y!, m! - 1, d! + offset)).toISOString().slice(0, 10);
    };
    for (const offset of [-1, 1]) {
      const near = await sup.get(`/client-portal/day?date=${dayKey(offset)}`);
      expect(near.body.onFloorNow).toHaveLength(2);
    }
    expect((await sup.get(`/client-portal/day?date=${dayKey(-3)}`)).body.onFloorNow).toEqual([]);
  });
});
