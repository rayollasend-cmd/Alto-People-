import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Ride-share, for seats in a van: the director assigns each van to a
 * driver; a rider's seat request goes to the drivers, who accept it (it joins
 * their van's run, re-timed) or decline it (the desk hears when everyone
 * has); the director's word overrides. Riders see their van and driver;
 * drivers see the riders asking. The fleet, by the numbers.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const STORE = { lat: 30.1766, lng: -85.8055 };
const MID = { lat: 30.25, lng: -85.9 };
const FAR = { lat: 30.3, lng: -85.95 };

async function world() {
  const client = await createClient('Coastal');
  const first = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  const store = await prisma.location.update({ where: { id: first.id }, data: { latitude: STORE.lat, longitude: STORE.lng } });
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mikeA = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  const { user: mike } = await createUser({ role: 'DRIVER', associateId: mikeA.id });
  const joA = await createAssociate({ firstName: 'Jo', lastName: 'Park' });
  const { user: jo } = await createUser({ role: 'DRIVER', associateId: joA.id });
  const van = await prisma.van.create({
    data: { name: 'Van 1', plate: 'ALT 101', capacity: 2, make: 'Ford', model: 'Transit', color: 'White', year: 2023 },
  });
  const targetAt = new Date(Date.now() + 20 * 3_600_000);
  targetAt.setMinutes(0, 0, 0);
  const serviceDate = dateKeyInZone(targetAt, store.timezone);
  const rider = async (firstName: string, at: { lat: number; lng: number }, minutes = 0) => {
    const a = await createAssociate({ firstName, lastName: 'Rider' });
    await prisma.associate.update({ where: { id: a.id }, data: { phone: '555-0199' } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    const ride = await prisma.ride.create({
      data: {
        associateId: a.id,
        direction: 'TO_WORK',
        locationId: store.id,
        address: `${firstName}'s place`,
        lat: at.lat,
        lng: at.lng,
        targetAt: new Date(targetAt.getTime() + minutes * 60_000),
        serviceDate,
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: director.id,
      },
    });
    return { associate: a, user, ride, agent: await loginAs(user.email) };
  };
  return {
    store,
    director,
    directorAgent: await loginAs(director.email),
    mike,
    mikeAgent: await loginAs(mike.email),
    jo,
    joAgent: await loginAs(jo.email),
    van,
    targetAt,
    serviceDate,
    rider,
  };
}

describe('the fleet — vans, their drivers, what they earn', () => {
  it('the director assigns a van to a driver (one van each), and takes it off them', async () => {
    const w = await world();
    const van2 = await w.directorAgent.post('/transport/vans').send({ name: 'Van 2', capacity: 12, make: 'Mercedes', model: 'Sprinter', color: 'Silver', year: 2024 });
    expect(van2.status).toBe(201);
    expect(van2.body.van.look).toBe('Silver Mercedes Sprinter 2024');

    const a1 = await w.directorAgent.patch(`/transport/vans/${w.van.id}`).send({ driverUserId: w.mike.id });
    expect(a1.body.van.driver).toMatchObject({ userId: w.mike.id, name: 'Mike Chen' });
    // Giving Mike Van 2 frees Van 1.
    await w.directorAgent.patch(`/transport/vans/${van2.body.van.id}`).send({ driverUserId: w.mike.id });
    expect((await prisma.van.findUniqueOrThrow({ where: { id: w.van.id } })).driverUserId).toBeNull();
    await flushPendingNotifications();
    expect(
      await prisma.notification.findFirst({ where: { recipientUserId: w.mike.id, channel: 'IN_APP', subject: "You're driving Van 2" } }),
    ).not.toBeNull();
    // Off him entirely.
    const off = await w.directorAgent.patch(`/transport/vans/${van2.body.van.id}`).send({ driverUserId: null });
    expect(off.body.van.driver).toBeNull();
    // Drivers can't assign vans.
    expect((await w.mikeAgent.patch(`/transport/vans/${w.van.id}`).send({ driverUserId: w.mike.id })).status).toBe(403);
  });

  it('reports what each van earned, carried, how full it ran, and how far it drove', async () => {
    const w = await world();
    const a = await w.rider('Ann', MID);
    const b = await w.rider('Bo', FAR);
    const run = await prisma.rideRun.create({
      data: { vanId: w.van.id, driverUserId: w.mike.id, direction: 'TO_WORK', serviceDate: w.serviceDate, departAt: w.targetAt, status: 'COMPLETED', createdById: w.director.id },
    });
    await prisma.ride.update({ where: { id: a.ride.id }, data: { runId: run.id, status: 'COMPLETED', chargeCents: 500 } });
    await prisma.ride.update({ where: { id: b.ride.id }, data: { runId: run.id, status: 'NO_SHOW', chargeCents: 100 } });
    await prisma.rideRunPing.createMany({
      data: [
        { runId: run.id, ...FAR, at: new Date() },
        { runId: run.id, ...MID, at: new Date(Date.now() + 60_000) },
        { runId: run.id, ...STORE, at: new Date(Date.now() + 120_000) },
      ],
    });
    const fleet = await w.directorAgent.get(`/transport/fleet?from=${w.serviceDate}&to=${w.serviceDate}`);
    expect(fleet.status).toBe(200);
    const v = fleet.body.vans.find((x: { id: string }) => x.id === w.van.id);
    expect(v.stats).toMatchObject({ revenueCents: 600, runs: 1, riders: 1, noShows: 1, seatFill: 50 });
    expect(v.stats.miles).toBeGreaterThan(8);
    expect(v.stats.daily).toEqual([{ date: w.serviceDate, cents: 600 }]);
  });
});

describe('seat requests — the drivers decide, the director overrides', () => {
  it('a driver with a van accepts a seat: it starts their run, and the rider hears who’s coming', async () => {
    const w = await world();
    const a = await w.rider('Ann', MID);
    // No van yet: can't accept.
    expect((await w.mikeAgent.post(`/transport/driver/requests/${a.ride.id}/accept`)).body.error.code).toBe('no_van');
    await prisma.van.update({ where: { id: w.van.id }, data: { driverUserId: w.mike.id } });

    const list = await w.mikeAgent.get('/transport/driver/requests');
    expect(list.body.van).toMatchObject({ name: 'Van 1', look: 'White Ford Transit 2023' });
    expect(list.body.requests.map((r: { id: string }) => r.id)).toEqual([a.ride.id]);

    const ok = await w.mikeAgent.post(`/transport/driver/requests/${a.ride.id}/accept`);
    expect(ok.status).toBe(200);
    expect(ok.body.run).toMatchObject({ status: 'PLANNED', van: { name: 'Van 1' }, driver: { userId: w.mike.id } });
    const saved = await prisma.ride.findUniqueOrThrow({ where: { id: a.ride.id } });
    expect(saved).toMatchObject({ status: 'SCHEDULED', acceptedById: w.mike.id });
    expect(saved.pickupAt!.getTime()).toBeLessThan(a.ride.targetAt.getTime());
    await flushPendingNotifications();
    const told = await prisma.notification.findFirst({ where: { recipientUserId: a.user.id, channel: 'IN_APP', subject: { startsWith: 'Seat confirmed — Van 1' } } });
    expect(told?.body).toMatch(/^Mike accepted your seat\. Van 1 · White Ford Transit 2023 · ALT 101 picks you up at Ann's place at /);

    // Taken: Jo can't have it.
    await prisma.van.create({ data: { name: 'Van 9', capacity: 8, driverUserId: w.jo.id } });
    expect((await w.joAgent.post(`/transport/driver/requests/${a.ride.id}/accept`)).body.error.code).toBe('taken');
  });

  it('a second seat joins the run, the pickups are re-ordered, and a moved rider hears the new time; a full van says so', async () => {
    const w = await world();
    await prisma.van.update({ where: { id: w.van.id }, data: { driverUserId: w.mike.id } });
    const near = await w.rider('Ann', MID);
    const far = await w.rider('Bo', FAR, 10);
    const third = await w.rider('Cy', MID, 15);
    await w.mikeAgent.post(`/transport/driver/requests/${near.ride.id}/accept`);
    const before = (await prisma.ride.findUniqueOrThrow({ where: { id: near.ride.id } })).pickupAt!;
    const joined = await w.mikeAgent.post(`/transport/driver/requests/${far.ride.id}/accept`);
    expect(joined.status).toBe(200);
    const runs = await prisma.rideRun.findMany();
    expect(runs).toHaveLength(1);
    const rides = await prisma.ride.findMany({ where: { runId: runs[0]!.id }, orderBy: { pickupOrder: 'asc' } });
    // Farthest first.
    expect(rides.map((r) => r.id)).toEqual([far.ride.id, near.ride.id]);
    await flushPendingNotifications();
    const after = rides.find((r) => r.id === near.ride.id)!.pickupAt!;
    if (Math.abs(after.getTime() - before.getTime()) >= 3 * 60_000) {
      expect(
        await prisma.notification.findFirst({ where: { recipientUserId: near.user.id, channel: 'IN_APP', subject: { startsWith: 'New pickup time' } } }),
      ).not.toBeNull();
    }
    // Two seats: the third doesn't fit.
    expect((await w.mikeAgent.post(`/transport/driver/requests/${third.ride.id}/accept`)).body.error.code).toBe('van_full');
  });

  it('a declined seat leaves that driver’s list; when every driver has declined, the desk hears — and can offer it again', async () => {
    const w = await world();
    await prisma.van.update({ where: { id: w.van.id }, data: { driverUserId: w.mike.id } });
    await prisma.van.create({ data: { name: 'Van 9', capacity: 8, driverUserId: w.jo.id } });
    const a = await w.rider('Ann', MID);
    expect((await w.mikeAgent.post(`/transport/driver/requests/${a.ride.id}/decline`).send({ reason: 'Too far out' })).status).toBe(200);
    expect((await w.mikeAgent.get('/transport/driver/requests')).body.requests).toHaveLength(0);
    expect((await w.joAgent.get('/transport/driver/requests')).body.requests).toHaveLength(1);

    await w.joAgent.post(`/transport/driver/requests/${a.ride.id}/decline`).send({});
    await flushPendingNotifications();
    expect(
      await prisma.notification.findFirst({ where: { recipientUserId: w.director.id, channel: 'IN_APP', subject: "No driver took Ann's seat" } }),
    ).not.toBeNull();
    const board = await w.directorAgent.get(`/transport/board?date=${w.serviceDate}`);
    expect(board.body.rides[0]).toMatchObject({ declines: 2, allDeclined: true });

    expect((await w.directorAgent.post(`/transport/rides/${a.ride.id}/reoffer`)).status).toBe(200);
    expect((await w.mikeAgent.get('/transport/driver/requests')).body.requests).toHaveLength(1);
  });

  it('the director’s dispatch is the acceptance — it overrides the drivers', async () => {
    const w = await world();
    const a = await w.rider('Ann', MID);
    await w.mikeAgent.post(`/transport/driver/requests/${a.ride.id}/decline`).send({});
    const run = await w.directorAgent.post('/transport/runs').send({
      vanId: w.van.id,
      driverUserId: w.mike.id,
      direction: 'TO_WORK',
      serviceDate: w.serviceDate,
      departAt: new Date(w.targetAt.getTime() - 3_600_000).toISOString(),
      rides: [{ rideId: a.ride.id, pickupAt: new Date(w.targetAt.getTime() - 40 * 60_000).toISOString() }],
    });
    expect(run.status).toBe(201);
    expect(await prisma.ride.findUniqueOrThrow({ where: { id: a.ride.id } })).toMatchObject({ status: 'SCHEDULED', acceptedById: w.director.id });
  });
});

describe('profiles — the rider’s van and driver, the driver’s riders', () => {
  it('the rider sees the van to look for and their driver — first name and initial', async () => {
    const w = await world();
    await prisma.van.update({ where: { id: w.van.id }, data: { driverUserId: w.mike.id } });
    const a = await w.rider('Ann', MID);
    expect((await a.agent.get(`/transport/me/rides/${a.ride.id}/crew`)).body.crew).toBeNull();
    await w.mikeAgent.post(`/transport/driver/requests/${a.ride.id}/accept`);
    const crew = (await a.agent.get(`/transport/me/rides/${a.ride.id}/crew`)).body.crew;
    expect(crew.van).toMatchObject({ name: 'Van 1', plate: 'ALT 101', look: 'White Ford Transit 2023', capacity: 2 });
    expect(crew.driver).toMatchObject({ name: 'Mike C.', trips: 0 });
    expect(JSON.stringify(crew)).not.toMatch(/Chen|555/);
  });

  it('a driver sees a rider asking for a seat or riding with them — not anyone else', async () => {
    const w = await world();
    const a = await w.rider('Ann', MID);
    const prof = await w.mikeAgent.get(`/transport/riders/${a.associate.id}`);
    expect(prof.body.rider).toMatchObject({ name: 'Ann Rider', phone: '555-0199', rides: 0, noShows: 0 });
    // A stranger with no open request isn't visible to drivers.
    const stranger = await createAssociate({ firstName: 'Zed', lastName: 'Nobody' });
    expect((await w.mikeAgent.get(`/transport/riders/${stranger.id}`)).status).toBe(404);
    // Associates can't look riders up.
    expect((await a.agent.get(`/transport/riders/${a.associate.id}`)).status).toBe(403);
  });
});
