import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { setGeocoderForTests } from '../../lib/geocode.js';
import { clusterAndOrder, clusterMembers, type ClusterMember } from '../../lib/rideClusters.js';
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
 * The driver's stops for a shift: riders within a short walk ride
 * together, the stops run farthest-from-the-store first on the way in,
 * and an address the lookup can't place waits for a pin — dropped once
 * by whoever is driving, and remembered.
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

// Panama City Beach: the store, a complex ~7 km out, its doorstep (~50 m
// away), a block over (~250 m), and a point ~20 km out.
const STORE = { lat: 30.1766, lng: -85.8055 };
const SEASIDE = { lat: 30.2106, lng: -85.865 };
const DOORSTEP = { lat: 30.211, lng: -85.8655 };
const BLOCK_OVER = { lat: 30.2126, lng: -85.8655 };
// Thomas Dr, a couple of miles off — its own stop, closer to the store.
const THOMAS = { lat: 30.1907, lng: -85.8109 };
const FAR = { lat: 30.3, lng: -85.95 };

const member = (rideId: string, name: string, point: { lat: number; lng: number } | null, address = `${name} St`): ClusterMember => ({
  rideId,
  associateId: `a-${rideId}`,
  name,
  label: address,
  address,
  point,
  pinned: !!point,
  status: 'REQUESTED',
});

describe('stops for a shift', () => {
  it('riders within a short walk are one stop; the rest are their own', () => {
    const clusters = clusterMembers([
      member('1', 'Rosa', SEASIDE),
      member('2', 'Tomas', DOORSTEP), // ~50 m — same stop
      member('3', 'Kim', BLOCK_OVER), // ~250 m — still the same stop
      member('4', 'Jay', FAR), // 20 km — its own
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.riders.map((r) => r.name)).toEqual(['Rosa', 'Tomas', 'Kim']);
    expect(clusters[0]!.spreadM).toBeGreaterThan(100);
    expect(clusters[1]!.riders.map((r) => r.name)).toEqual(['Jay']);
  });

  it('a stop takes its name: a named pickup point, else the street the addresses share', () => {
    const thomas = clusterMembers([
      member('1', 'Dana', SEASIDE, '7215 Thomas Dr, Panama City Beach, FL'),
      member('2', 'Jay', DOORSTEP, '7240 Thomas Dr, Panama City Beach, FL'),
    ]);
    expect(thomas[0]!.label).toBe('Thomas Dr');
    // Someone chose the complex by name — that name wins.
    const complex = clusterMembers([
      { ...member('3', 'Rosa', SEASIDE, '100 Gulf Blvd'), label: 'Seaside Housing' },
      member('4', 'Kim', DOORSTEP, '104 Gulf Blvd'),
    ]);
    expect(complex[0]!.label).toBe('Seaside Housing');
    // Different streets: the first address stands for the stop.
    const mixed = clusterMembers([member('5', 'A', SEASIDE, '1 Pine Ln'), member('6', 'B', DOORSTEP, '9 Oak Ct')]);
    expect(mixed[0]!.label).toBe('1 Pine Ln');
  });

  it('addresses with no pin group by what was written, and say they aren’t on the map', () => {
    const clusters = clusterMembers([
      member('1', 'Rosa', null, '77 Beach Dr'),
      member('2', 'Tomas', null, ' 77 beach dr '), // the same place, typed differently
      member('3', 'Kim', null, '12 Pine Ln'),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.mapped).toBe(false);
    expect(clusters[0]!.riders.map((r) => r.name)).toEqual(['Rosa', 'Tomas']);
  });

  it('works the stops farthest-from-the-store first on the way in, nearest drop first coming home', () => {
    const members = [member('1', 'Near', DOORSTEP), member('2', 'Far', FAR)];
    expect(clusterAndOrder(members, STORE, 'TO_WORK').map((c) => c.riders[0]!.name)).toEqual(['Far', 'Near']);
    expect(clusterAndOrder(members, STORE, 'FROM_WORK').map((c) => c.riders[0]!.name)).toEqual(['Near', 'Far']);
    // Unmapped stops keep their place at the end — nothing can route to them.
    const withBlank = [...members, member('3', 'Blank', null)];
    const ordered = clusterAndOrder(withBlank, STORE, 'TO_WORK');
    expect(ordered.map((c) => c.order)).toEqual([1, 2, 3]);
    expect(ordered[2]!.mapped).toBe(false);
  });
});

describe('GET /transport/driver/trip-map', () => {
  async function world() {
    setGeocoderForTests(async () => null); // nothing typed gets found
    const client = await createClient('Coastal');
    const first = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const store = await prisma.location.update({ where: { id: first.id }, data: { latitude: STORE.lat, longitude: STORE.lng } });
    const stop = await prisma.transportStop.create({ data: { name: 'Seaside Housing', address: '100 Gulf Blvd', ...SEASIDE } });
    const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
    const mike = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
    const { user: driver } = await createUser({ role: 'DRIVER', associateId: mike.id });
    const targetAt = new Date(Date.now() + 20 * 3600_000);
    const serviceDate = dateKeyInZone(targetAt, 'America/New_York');
    const rider = async (firstName: string, home: Record<string, unknown>) => {
      const a = await createAssociate({ firstName, lastName: 'Rider' });
      const ride = await prisma.ride.create({
        data: {
          associateId: a.id,
          direction: 'TO_WORK',
          locationId: store.id,
          ...home,
          targetAt,
          serviceDate,
          windowLabel: 'Morning',
          fareCents: 500,
          noShowFeeCents: 100,
          createdById: director.id,
        },
      });
      return { associate: a, ride };
    };
    const rosa = await rider('Rosa', { stopId: stop.id });
    const tomas = await rider('Tomas', { stopId: stop.id });
    const kim = await rider('Kim', { address: '7209 Thomas Dr', ...THOMAS });
    const jay = await rider('Jay', { address: '900 Nowhere Rd' }); // no pin, no lookup
    return { store, stop, driver, director, serviceDate, rosa, tomas, kim, jay };
  }

  it('groups the shift’s riders into stops, in the order to work them, and says who still needs a pin', async () => {
    const w = await world();
    const agent = await loginAs(w.driver.email);
    const res = await agent.get(
      `/transport/driver/trip-map?locationId=${w.store.id}&direction=TO_WORK&date=${w.serviceDate}&windowLabel=Morning`,
    );
    expect(res.status).toBe(200);
    expect(res.body.trip).toMatchObject({ store: { name: w.store.name, clientName: 'Coastal' }, riders: 4, requested: 4, windowLabel: 'Morning' });
    expect(res.body.trip.store.point).toEqual(STORE);

    // Seaside (with its doorstep neighbour) is farther out than Thomas Dr,
    // so it is stop 1; Jay has no pin, so he waits at the end.
    const [first, second, last] = res.body.clusters;
    expect(first).toMatchObject({ order: 1, mapped: true, label: 'Seaside Housing' });
    expect(first.riders.map((r: { name: string }) => r.name)).toEqual(['Rosa Rider', 'Tomas Rider']);
    expect(first.riders[0].pinned).toBe(true);
    expect(second).toMatchObject({ order: 2, mapped: true });
    expect(second.riders[0].photoUrl).toContain('/photo');
    expect(last).toMatchObject({ order: 3, mapped: false, address: '900 Nowhere Rd' });
    expect(res.body.unmapped).toBe(1);
  });

  it('a dropped pin sticks to the ride, their saved place, and the rides still ahead', async () => {
    const w = await world();
    const agent = await loginAs(w.driver.email);
    await prisma.ridePlace.create({ data: { associateId: w.jay.associate.id, label: 'Home', address: '900 Nowhere Rd' } });
    const later = await prisma.ride.create({
      data: {
        associateId: w.jay.associate.id,
        direction: 'TO_WORK',
        locationId: w.store.id,
        address: '900 Nowhere Rd',
        targetAt: new Date(Date.now() + 44 * 3600_000),
        serviceDate: dateKeyInZone(new Date(Date.now() + 44 * 3600_000), 'America/New_York'),
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: w.director.id,
      },
    });

    const res = await agent.post(`/transport/rides/${w.jay.ride.id}/pin`).send({ lat: 30.2, lng: -85.88 });
    expect(res.status).toBe(200);
    const pinned = await prisma.ride.findUniqueOrThrow({ where: { id: w.jay.ride.id }, select: { lat: true, lng: true } });
    expect(Number(pinned.lat)).toBeCloseTo(30.2, 5);
    expect(Number((await prisma.ridePlace.findFirstOrThrow({ where: { associateId: w.jay.associate.id } })).lat)).toBeCloseTo(30.2, 5);
    expect(Number((await prisma.ride.findUniqueOrThrow({ where: { id: later.id } })).lng)).toBeCloseTo(-85.88, 5);

    // On the map now, and no longer waiting for a pin.
    const map = await agent.get(`/transport/driver/trip-map?locationId=${w.store.id}&direction=TO_WORK&date=${w.serviceDate}&windowLabel=Morning`);
    expect(map.body.unmapped).toBe(0);
  });

  it('a shared stop is dispatch’s to move, not a driver’s', async () => {
    const w = await world();
    const driver = await loginAs(w.driver.email);
    const refused = await driver.post(`/transport/rides/${w.rosa.ride.id}/pin`).send({ lat: 30.3, lng: -85.9 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('Seaside Housing');

    const dispatch = await loginAs(w.director.email);
    expect((await dispatch.post(`/transport/rides/${w.rosa.ride.id}/pin`).send({ lat: 30.3, lng: -85.9 })).status).toBe(200);
    expect(Number((await prisma.transportStop.findUniqueOrThrow({ where: { id: w.stop.id } })).lat)).toBeCloseTo(30.3, 5);
  });
});
