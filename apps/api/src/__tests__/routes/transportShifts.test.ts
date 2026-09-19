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
 * Planning ahead by shift: riders book the store shift they work, not a
 * time; drivers accept seats until their van is full; the rest wait in
 * line — first booked, first seated — and a seat that opens goes to the
 * first in line automatically. Riders see who they ride with as faces;
 * drivers see their week like a schedule.
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

const NY = 'America/New_York';
const STORE = { lat: 30.1766, lng: -85.8055 };

async function world() {
  const client = await createClient('Coastal');
  const first = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  const store = await prisma.location.update({
    where: { id: first.id },
    data: { timezone: NY, latitude: STORE.lat, longitude: STORE.lng },
  });
  // The store's shifts: Morning 6 AM–2 PM, Overnight 10 PM–6 AM.
  await prisma.staffingTarget.createMany({
    data: [
      { locationId: store.id, targetCount: 10, effectiveFrom: new Date('2026-01-01'), label: 'Morning', startMinute: 360, endMinute: 840 },
      { locationId: store.id, targetCount: 10, effectiveFrom: new Date('2026-01-01'), label: 'Overnight', startMinute: 1320, endMinute: 360 },
    ],
  });
  const stop = await prisma.transportStop.create({ data: { name: 'Seaside Housing', address: '100 Gulf Blvd', lat: 30.21, lng: -85.86 } });
  const mikeA = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  const { user: mike } = await createUser({ role: 'DRIVER', associateId: mikeA.id });
  const joA = await createAssociate({ firstName: 'Jo', lastName: 'Park' });
  const { user: jo } = await createUser({ role: 'DRIVER', associateId: joA.id });
  await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 2, driverUserId: mike.id } });
  await prisma.van.create({ data: { name: 'Van 2', plate: 'ALT 102', capacity: 12, driverUserId: jo.id } });
  // A store day three days out — well past the 10-hour cutoff.
  const date = dateKeyInZone(new Date(Date.now() + 3 * 86_400_000), NY);

  async function rider(firstName: string) {
    const a = await createAssociate({ firstName, lastName: 'Rider' });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    await prisma.rideConsent.create({ data: { associateId: a.id, fareCents: 500, noShowFeeCents: 100 } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    const agent = await loginAs(user.email);
    const book = async (windowLabel = 'Morning', direction: 'TO_WORK' | 'FROM_WORK' = 'TO_WORK') => {
      const r = await agent.post('/transport/me/rides').send({ direction, locationId: store.id, stopId: stop.id, windowLabel, date });
      expect(r.status).toBe(201);
      return r.body.ride as { id: string; targetAt: string; windowLabel: string; waitlist: { position: number; of: number } | null };
    };
    return { associate: a, user, agent, book };
  }
  return { store, stop, mike, mikeAgent: await loginAs(mike.email), jo, joAgent: await loginAs(jo.email), date, rider };
}

const localTime = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit', day: 'numeric' }).format(new Date(iso));

describe('booking by shift', () => {
  it('the ride’s time is the shift’s — to work by its start, home at its end, an overnight home the next morning', async () => {
    const w = await world();
    const ann = await w.rider('Ann');
    const day = Number(w.date.slice(8));
    const there = await ann.book('Morning', 'TO_WORK');
    expect(there.windowLabel).toBe('Morning');
    expect(localTime(there.targetAt)).toBe(`${day}, 6:00 AM`);
    const home = await ann.book('Morning', 'FROM_WORK');
    expect(localTime(home.targetAt)).toBe(`${day}, 2:00 PM`);
    const bo = await w.rider('Bo');
    const nightHome = await bo.book('Overnight', 'FROM_WORK');
    const next = new Date(Date.parse(`${w.date}T12:00:00Z`) + 86_400_000).getUTCDate();
    expect(localTime(nightHome.targetAt)).toBe(`${next}, 6:00 AM`);

    // The store's shifts, for the booking form — no van on them yet.
    const trips = await ann.agent.get(`/transport/me/trips?locationId=${w.store.id}&date=${w.date}`);
    expect(trips.body.windows.map((x: { label: string }) => x.label)).toEqual(['Morning', 'Overnight']);
    expect(trips.body.trips.find((x: { windowLabel: string; direction: string }) => x.windowLabel === 'Morning' && x.direction === 'TO_WORK')).toMatchObject({
      bookable: true,
      seats: null,
      full: false,
      waiting: 1,
    });
    const me = await ann.agent.get('/transport/me');
    expect(me.body.stores[0].windows).toEqual([
      { label: 'Morning', startMinute: 360, endMinute: 840 },
      { label: 'Overnight', startMinute: 1320, endMinute: 360 },
    ]);

    // A shift the store doesn't have is refused; an other time still books.
    const bad = await ann.agent.post('/transport/me/rides').send({ direction: 'TO_WORK', locationId: w.store.id, stopId: w.stop.id, windowLabel: 'Swing', date: w.date });
    expect(bad.body.error.code).toBe('shift_not_found');
    const other = await bo.agent
      .post('/transport/me/rides')
      .send({ direction: 'TO_WORK', locationId: w.store.id, stopId: w.stop.id, targetAt: new Date(Date.now() + 4 * 86_400_000).toISOString() });
    expect(other.status).toBe(201);
    expect(other.body.ride.windowLabel).toBeNull();
  });
});

describe('seats and the waitlist', () => {
  it('drivers fill their van; the rest wait in line, told their place — and a new booking sees its place', async () => {
    const w = await world();
    const [ann, bo, cy] = [await w.rider('Ann'), await w.rider('Bo'), await w.rider('Cy')];
    const [a, b, c] = [await ann.book(), await bo.book(), await cy.book()];
    expect(a.waitlist).toBeNull();

    expect((await w.mikeAgent.post(`/transport/driver/requests/${a.id}/accept`)).status).toBe(200);
    expect((await w.mikeAgent.post(`/transport/driver/requests/${b.id}/accept`)).status).toBe(200);
    await flushPendingNotifications();
    // Van 1 (2 seats) is full: Cy is first in line, and told.
    const told = await prisma.notification.findFirst({ where: { recipientUserId: cy.user.id, channel: 'IN_APP', subject: { contains: 'waitlist' } } });
    expect(told?.subject).toBe("The Morning van is full — you're #1 on the waitlist");
    expect((await w.mikeAgent.post(`/transport/driver/requests/${c.id}/accept`)).body.error.code).toBe('van_full');

    const dee = await w.rider('Dee');
    const d = await dee.book();
    expect(d.waitlist).toEqual({ position: 2, of: 2 });
    const mine = (await cy.agent.get('/transport/me')).body.rides.find((r: { id: string }) => r.id === c.id);
    expect(mine).toMatchObject({ status: 'REQUESTED', waitlist: { position: 1, of: 2 }, seats: { capacity: 2, taken: 2 } });

    // Drivers see the line, in order; the booking form sees the shift full.
    const asks = (await w.joAgent.get('/transport/driver/requests')).body.requests as Array<{ id: string; waitlist: unknown; windowLabel: string }>;
    expect(asks.find((r) => r.id === c.id)).toMatchObject({ windowLabel: 'Morning', waitlist: { position: 1, of: 2 } });
    const trips = await dee.agent.get(`/transport/me/trips?locationId=${w.store.id}&date=${w.date}`);
    expect(trips.body.trips.find((x: { windowLabel: string; direction: string }) => x.windowLabel === 'Morning' && x.direction === 'TO_WORK')).toMatchObject({
      vans: 1,
      seats: { capacity: 2, taken: 2 },
      full: true,
      waiting: 2,
    });

    // Another driver taking a seat adds a van: nobody's full any more.
    expect((await w.joAgent.post(`/transport/driver/requests/${c.id}/accept`)).status).toBe(200);
    const after = (await dee.agent.get('/transport/me')).body.rides.find((r: { id: string }) => r.id === d.id);
    expect(after.waitlist).toBeNull();
    expect(after.seats).toEqual({ capacity: 14, taken: 3 });
  });

  it('a seat that opens goes to the first in line — automatically — and the driver hears who', async () => {
    const w = await world();
    const [ann, bo, cy, dee] = [await w.rider('Ann'), await w.rider('Bo'), await w.rider('Cy'), await w.rider('Dee')];
    const [a, b, c, d] = [await ann.book(), await bo.book(), await cy.book(), await dee.book()];
    await w.mikeAgent.post(`/transport/driver/requests/${a.id}/accept`);
    await w.mikeAgent.post(`/transport/driver/requests/${b.id}/accept`);

    expect((await ann.agent.post(`/transport/me/rides/${a.id}/cancel`)).status).toBe(200);
    await flushPendingNotifications();
    const seated = await prisma.ride.findUniqueOrThrow({ where: { id: c.id } });
    const run = await prisma.ride.findUniqueOrThrow({ where: { id: b.id }, select: { runId: true } });
    expect(seated).toMatchObject({ status: 'SCHEDULED', runId: run.runId });
    expect(seated.pickupAt).not.toBeNull();
    expect(
      await prisma.notification.findFirst({ where: { recipientUserId: cy.user.id, channel: 'IN_APP', subject: "A seat opened — you're on Van 1" } }),
    ).not.toBeNull();
    expect(
      await prisma.notification.findFirst({ where: { recipientUserId: w.mike.id, channel: 'IN_APP', subject: 'Cy took the open seat' } }),
    ).not.toBeNull();
    // Dee moves up.
    const deeRide = (await dee.agent.get('/transport/me')).body.rides.find((r: { id: string }) => r.id === d.id);
    expect(deeRide.waitlist).toEqual({ position: 1, of: 1 });
  });
});

describe('who rides with whom', () => {
  it('riders see the faces they ride with — never their names', async () => {
    const w = await world();
    const [ann, bo] = [await w.rider('Ann'), await w.rider('Bo')];
    await prisma.associate.update({ where: { id: bo.associate.id }, data: { photoS3Key: 'photos/bo.jpg' } });
    const [a, b] = [await ann.book(), await bo.book()];
    await w.mikeAgent.post(`/transport/driver/requests/${a.id}/accept`);
    await w.mikeAgent.post(`/transport/driver/requests/${b.id}/accept`);

    const annRide = (await ann.agent.get('/transport/me')).body.rides.find((r: { id: string }) => r.id === a.id);
    expect(annRide.coRiders).toEqual([{ photoUrl: `/api/associates/${bo.associate.id}/photo` }]);
    expect(JSON.stringify(annRide)).not.toMatch(/Bo /);
    const boRide = (await bo.agent.get('/transport/me')).body.rides.find((r: { id: string }) => r.id === b.id);
    expect(boRide.coRiders).toEqual([{ photoUrl: null }]);
  });

  it('the driver’s week, like a schedule: each run’s shift, seats, riders by name — and the shifts still asking', async () => {
    const w = await world();
    const [ann, bo, cy] = [await w.rider('Ann'), await w.rider('Bo'), await w.rider('Cy')];
    const [a, b] = [await ann.book(), await bo.book()];
    await cy.book('Morning', 'FROM_WORK');
    await w.mikeAgent.post(`/transport/driver/requests/${a.id}/accept`);
    await w.mikeAgent.post(`/transport/driver/requests/${b.id}/accept`);

    const week = await w.mikeAgent.get(`/transport/driver/schedule?from=${w.date}&days=7`);
    expect(week.status).toBe(200);
    expect(week.body.runs).toHaveLength(1);
    expect(week.body.runs[0]).toMatchObject({
      serviceDate: w.date,
      direction: 'TO_WORK',
      shift: 'Morning',
      seats: { taken: 2, capacity: 2 },
      van: { name: 'Van 1' },
    });
    expect(week.body.runs[0].riders.map((r: { name: string }) => r.name).sort()).toEqual(['Ann Rider', 'Bo Rider']);
    expect(week.body.asking).toEqual([
      expect.objectContaining({ serviceDate: w.date, direction: 'FROM_WORK', windowLabel: 'Morning', count: 1 }),
    ]);
  });
});
