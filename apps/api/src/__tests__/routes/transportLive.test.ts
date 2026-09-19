import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { setGeocoderForTests } from '../../lib/geocode.js';
import { planRun, runVanTrailRetention } from '../../lib/transportLive.js';
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
 * The vans live: the driver's phone shares the van's position while the run
 * is on the road; riders watch it come (their own pickup only), hear it
 * when it's about 10 minutes out; a van running late into a store tells
 * that store's supervisors; the desk sees every van.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
});
afterEach(() => {
  setGeocoderForTests(null);
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

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

// Panama City Beach: the store, a housing complex ~7 km off, a point
// ~20 km out, and one on the complex's doorstep.
const STORE = { lat: 30.1766, lng: -85.8055 };
const SEASIDE = { lat: 30.2106, lng: -85.865 };
const FAR = { lat: 30.3, lng: -85.95 };
const DOORSTEP = { lat: 30.211, lng: -85.8655 };

async function onTheRoad(opts: { arriveInMinutes?: number } = {}) {
  const client = await createClient('Coastal');
  const first = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  const store = await prisma.location.update({ where: { id: first.id }, data: { latitude: STORE.lat, longitude: STORE.lng } });
  const stop = await prisma.transportStop.create({ data: { name: 'Seaside Housing', address: '100 Gulf Blvd', ...SEASIDE } });
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mike = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  const { user: driver } = await createUser({ role: 'DRIVER', associateId: mike.id });
  const van = await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 12 } });
  const targetAt = inMinutes(opts.arriveInMinutes ?? 90);
  const serviceDate = dateKeyInZone(targetAt, store.timezone);

  async function rider(firstName: string, home: { stopId: string } | { address: string; lat: number; lng: number }) {
    const a = await createAssociate({ firstName, lastName: 'Rider' });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    const ride = await prisma.ride.create({
      data: {
        associateId: a.id,
        direction: 'TO_WORK',
        locationId: store.id,
        ...home,
        targetAt,
        serviceDate,
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: director.id,
      },
    });
    return { associate: a, user, ride, agent: await loginAs(user.email) };
  }
  const kim = await rider('Kim', { stopId: stop.id });
  const ana = await rider('Ana', { address: '9 Harbor Rd, Panama City Beach', lat: 30.25, lng: -85.9 });

  const directorAgent = await loginAs(director.email);
  const dispatched = await directorAgent.post('/transport/runs').send({
    vanId: van.id,
    driverUserId: driver.id,
    direction: 'TO_WORK',
    serviceDate,
    departAt: inMinutes(-5).toISOString(),
    rides: [
      { rideId: kim.ride.id, pickupAt: inMinutes(10).toISOString() },
      { rideId: ana.ride.id, pickupAt: inMinutes(20).toISOString() },
    ],
  });
  expect(dispatched.status).toBe(201);
  const runId = dispatched.body.run.id as string;
  const driverAgent = await loginAs(driver.email);

  /** The phone reports a position (the 4-second throttle stepped around). */
  async function ping(p: { lat: number; lng: number }) {
    await prisma.rideRun.updateMany({
      where: { id: runId, lastLocationAt: { not: null } },
      data: { lastLocationAt: new Date(Date.now() - 60_000) },
    });
    const r = await driverAgent.post(`/transport/driver/runs/${runId}/location`).send({ ...p, heading: 90, speed: 12, accuracy: 8 });
    expect(r.status).toBe(202);
    await flushPendingNotifications();
    return r;
  }
  return { client, store, stop, director, directorAgent, driver, driverAgent, van, runId, kim, ana, ping, targetAt };
}

describe('the van on the map', () => {
  it('shares where the van is only once the run is on the road, and only from its own driver', async () => {
    const s = await onTheRoad();
    const early = await s.driverAgent.post(`/transport/driver/runs/${s.runId}/location`).send(FAR);
    expect(early.body.error.code).toBe('not_active');

    const { user: other } = await createUser({ role: 'DRIVER' });
    expect((await (await loginAs(other.email)).post(`/transport/driver/runs/${s.runId}/location`).send(FAR)).status).toBe(404);

    expect((await s.driverAgent.post(`/transport/driver/runs/${s.runId}/start`)).status).toBe(200);
    await s.ping(FAR);
    const run = await prisma.rideRun.findUniqueOrThrow({ where: { id: s.runId } });
    expect(Number(run.lastLat)).toBeCloseTo(FAR.lat, 4);
    expect(run.lastHeading).toBe(90);
    expect(await prisma.rideRunPing.count({ where: { runId: s.runId } })).toBe(1);

    // A phone firing too fast is ignored, not stored.
    const burst = await s.driverAgent.post(`/transport/driver/runs/${s.runId}/location`).send(FAR);
    expect(burst.body.skipped).toBe(true);
    expect(await prisma.rideRunPing.count({ where: { runId: s.runId } })).toBe(1);
  });

  it('the rider watches it come — the van, their own pickup, the ETA, the stops before them — never another rider’s address', async () => {
    const s = await onTheRoad();
    // Not left yet: the ride shows, without a van position.
    const before = await s.kim.agent.get('/transport/me/live');
    expect(before.body.live).toMatchObject({ runStatus: 'PLANNED', position: null, van: { name: 'Van 1' } });

    await s.driverAgent.post(`/transport/driver/runs/${s.runId}/start`);
    await s.ping(FAR);
    const kim = (await s.kim.agent.get('/transport/me/live')).body.live;
    expect(kim).toMatchObject({
      runStatus: 'ACTIVE',
      status: 'SCHEDULED',
      stopsBefore: 0,
      driver: 'Mike',
      pickup: { label: 'Seaside Housing', point: SEASIDE },
      destination: { label: expect.any(String), point: STORE },
    });
    expect(kim.position).toMatchObject({ lat: FAR.lat, lng: FAR.lng, heading: 90 });
    const pickupMin = (Date.parse(kim.pickup.etaAt) - Date.now()) / 60_000;
    expect(pickupMin).toBeGreaterThan(15);
    expect(pickupMin).toBeLessThan(40);
    expect(Date.parse(kim.destination.etaAt)).toBeGreaterThan(Date.parse(kim.pickup.etaAt));

    // Ana is second: one stop before her. Kim's view never carries Ana.
    expect((await s.ana.agent.get('/transport/me/live')).body.live.stopsBefore).toBe(1);
    expect(JSON.stringify(kim)).not.toMatch(/Harbor|Ana/);
  });

  it('the rider sees the trip from the moment they ask — finding a driver, then a van that leaves later', async () => {
    const s = await onTheRoad();
    // A seat asked for tomorrow: no van yet, but both ends of the trip.
    const tomorrow = await prisma.ride.create({
      data: {
        associateId: s.kim.associate.id,
        direction: 'FROM_WORK',
        locationId: s.store.id,
        stopId: s.stop.id,
        targetAt: inMinutes(26 * 60),
        serviceDate: dateKeyInZone(inMinutes(26 * 60), s.store.timezone),
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: s.kim.user.id,
      },
    });
    // Kim's van today is done with her: her next ride is tomorrow's.
    await prisma.ride.update({ where: { id: s.kim.ride.id }, data: { status: 'COMPLETED' } });
    const finding = (await s.kim.agent.get('/transport/me/live')).body.live;
    expect(finding).toMatchObject({
      rideId: tomorrow.id,
      status: 'REQUESTED',
      runStatus: null,
      van: null,
      driver: null,
      position: null,
      pickup: { label: expect.any(String), point: STORE, etaAt: null },
      destination: { label: 'Seaside Housing', point: SEASIDE },
    });

    // On a van that leaves in 20 hours: the van and driver, still no position.
    await prisma.rideRun.update({ where: { id: s.runId }, data: { departAt: inMinutes(20 * 60) } });
    await prisma.ride.update({ where: { id: s.ana.ride.id }, data: { targetAt: inMinutes(21 * 60) } });
    const later = (await s.ana.agent.get('/transport/me/live')).body.live;
    expect(later).toMatchObject({
      status: 'SCHEDULED',
      runStatus: 'PLANNED',
      van: { name: 'Van 1', plate: 'ALT 101' },
      driver: 'Mike',
      position: null,
      pickup: { point: { lat: 30.25, lng: -85.9 } },
      destination: { point: STORE },
    });
    expect(JSON.stringify(later)).not.toMatch(/Seaside|Kim/);
  });

  it('about 10 minutes out, the rider hears it — once', async () => {
    const s = await onTheRoad();
    await s.driverAgent.post(`/transport/driver/runs/${s.runId}/start`);
    await s.ping(FAR);
    const near = { recipientUserId: s.kim.user.id, channel: 'IN_APP' as const, subject: { startsWith: 'Your van is about' } };
    expect(await prisma.notification.count({ where: near })).toBe(0);

    await s.ping(DOORSTEP);
    const told = await prisma.notification.findFirstOrThrow({ where: near });
    expect(told.subject).toBe('Your van is about 1 min away');
    expect(told.body).toMatch(/Van 1 is about 1 min from Seaside Housing/);
    await s.ping(DOORSTEP);
    expect(await prisma.notification.count({ where: near })).toBe(1);
  });

  it('running late into the store tells its supervisors and the desk — once, heads-up only', async () => {
    const s = await onTheRoad({ arriveInMinutes: 5 });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: s.client.id });
    const elsewhere = await createClient('Target');
    const { user: otherSup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: elsewhere.id });
    await s.driverAgent.post(`/transport/driver/runs/${s.runId}/start`);
    await s.ping(FAR);

    const late = { channel: 'IN_APP' as const, subject: { contains: 'running about' } };
    const told = await prisma.notification.findFirstOrThrow({ where: { ...late, recipientUserId: sup.id } });
    expect(told.subject).toMatch(/^Van 1 is running about \d+ min late$/);
    expect(told.body).toMatch(/Kim Rider, Ana Rider — expected at .+ Heads-up only\./);
    expect(await prisma.notification.count({ where: { ...late, recipientUserId: s.director.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { ...late, recipientUserId: otherSup.id } })).toBe(0);

    await s.ping(FAR);
    expect(await prisma.notification.count({ where: { ...late, recipientUserId: sup.id } })).toBe(1);

    // The supervisor's arrivals list carries the ETA and how late.
    const arrivals = (await (await loginAs(sup.email)).get('/transport/arrivals')).body.arrivals;
    expect(arrivals).toHaveLength(2);
    expect(arrivals[0].etaAt).toEqual(expect.any(String));
    expect(arrivals[0].lateMinutes).toBeGreaterThanOrEqual(5);
  });

  it('the desk sees every van: where it is, its trail, the stops in order with who is at each', async () => {
    const s = await onTheRoad();
    await s.driverAgent.post(`/transport/driver/runs/${s.runId}/start`);
    await s.ping(FAR);
    await s.ping(DOORSTEP);
    const live = await s.directorAgent.get('/transport/live');
    expect(live.status).toBe(200);
    const run = live.body.runs.find((r: { runId: string }) => r.runId === s.runId);
    expect(run).toMatchObject({ status: 'ACTIVE', van: { name: 'Van 1' }, driver: { name: 'Mike Chen' }, stale: false });
    expect(run.trail).toHaveLength(2);
    expect(run.waypoints.map((w: { kind: string; label: string }) => [w.kind, w.label])).toEqual([
      ['pickup', 'Kim Rider'],
      ['pickup', 'Ana Rider'],
      ['store', s.store.name],
    ]);
    expect(run.riders.map((r: { name: string }) => r.name)).toEqual(['Kim Rider', 'Ana Rider']);
    // The driver sees their own run the same way; a rider can't.
    expect((await s.driverAgent.get(`/transport/driver/runs/${s.runId}/live`)).body.run.waypoints).toHaveLength(3);
    expect((await s.kim.agent.get('/transport/live')).status).toBe(403);
  });

  it('keeps the van’s trail 30 days', async () => {
    const s = await onTheRoad();
    await prisma.rideRunPing.createMany({
      data: [
        { runId: s.runId, ...FAR, at: new Date(Date.now() - 31 * 86_400_000) },
        { runId: s.runId, ...FAR, at: new Date(Date.now() - 2 * 86_400_000) },
      ],
    });
    expect(await runVanTrailRetention()).toBe(1);
    expect(await prisma.rideRunPing.count()).toBe(1);
  });
});

describe('addresses on the map', () => {
  it('looks an address up once; the phone’s own point needs no lookup; “use where I am” names the street', async () => {
    const lookups: string[] = [];
    setGeocoderForTests(
      async (address) => {
        lookups.push(address);
        return { lat: 30.25, lng: -85.9 };
      },
      async () => '9 Harbor Rd, Panama City Beach, FL 32413',
    );
    const client = await createClient('Coastal');
    const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const a = await createAssociate({ firstName: 'Kim', lastName: 'Nguyen' });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    const kim = await loginAs(user.email);
    await kim.post('/transport/me/consent');

    expect((await kim.get('/transport/me/where?lat=30.25&lng=-85.9')).body.address).toBe('9 Harbor Rd, Panama City Beach, FL 32413');

    const body = (h: number) => ({
      direction: 'TO_WORK',
      locationId: store.id,
      address: '9 Harbor Rd, Panama City Beach, FL 32413',
      targetAt: new Date(Date.now() + h * 3_600_000).toISOString(),
    });
    const first = await kim.post('/transport/me/rides').send(body(20));
    expect(first.body.ride.point).toEqual({ lat: 30.25, lng: -85.9 });
    const again = await kim.post('/transport/me/rides').send(body(30));
    expect(again.body.ride.point).toEqual({ lat: 30.25, lng: -85.9 });
    expect(lookups).toHaveLength(1);

    // Saved from where they stand: the phone's point, no lookup.
    await kim.post('/transport/me/places').send({ label: 'Home', address: '12 Oak St, Destin FL', lat: 30.39, lng: -86.49 });
    const place = await prisma.ridePlace.findFirstOrThrow({ where: { associateId: a.id } });
    expect([Number(place.lat), Number(place.lng)]).toEqual([30.39, -86.49]);
    expect(lookups).toHaveLength(1);
  });
});

describe('planRun — the order a van visits its stops', () => {
  const at = new Date('2026-09-19T11:00:00.000Z');
  it('home from work: the store first, then each rider home in order', () => {
    const plan = planRun({
      direction: 'FROM_WORK',
      van: STORE,
      now: at,
      rides: [
        { id: 'b', status: 'SCHEDULED', pickupOrder: 2, targetAt: at, locationId: 'L', home: FAR },
        { id: 'a', status: 'SCHEDULED', pickupOrder: 1, targetAt: at, locationId: 'L', home: SEASIDE },
      ],
      stores: new Map([['L', STORE]]),
    });
    expect(plan.waypoints.map((w) => [w.kind, w.rideIds.join(',')])).toEqual([
      ['store', 'a,b'],
      ['drop', 'a'],
      ['drop', 'b'],
    ]);
    expect(plan.pickupEta.get('a')?.getTime()).toBe(at.getTime()); // already at the store
    expect(plan.dropEta.get('b')!.getTime()).toBeGreaterThan(plan.dropEta.get('a')!.getTime());
  });

  it('to work: a rider already aboard skips the pickups; lateness is against the earliest arrive-by', () => {
    const plan = planRun({
      direction: 'TO_WORK',
      van: FAR,
      now: at,
      rides: [
        { id: 'on', status: 'BOARDED', pickupOrder: 1, targetAt: new Date(at.getTime() + 5 * 60_000), locationId: 'L', home: FAR },
        { id: 'next', status: 'SCHEDULED', pickupOrder: 2, targetAt: new Date(at.getTime() + 60 * 60_000), locationId: 'L', home: SEASIDE },
      ],
      stores: new Map([['L', STORE]]),
    });
    expect(plan.waypoints.map((w) => w.kind)).toEqual(['pickup', 'store']);
    expect(plan.lateMinutes.get('L')).toBeGreaterThan(20);
  });
});
