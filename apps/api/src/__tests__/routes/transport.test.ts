import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { setGeocoderForTests } from '../../lib/geocode.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The Alto vans. Associates book a seat to or from work — independent of the
 * schedule — at least 10 hours ahead; the Transportation Director dispatches
 * bookings onto van runs; the driver marks each rider on board ($5) or a
 * no-show ($1); what's owed comes out of that pay period's paycheck.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
  // Production geocodes every pickup, and a booking whose address can't be
  // placed is now refused outright — an unfindable pickup is worse than no
  // booking. These tests are about booking rules, not about the geocoder,
  // so stand one up that answers. The refusal has its own test below.
  setGeocoderForTests(async () => ({ lat: 30.39, lng: -86.49 }));
});
afterAll(async () => {
  setGeocoderForTests(null);
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

async function seed() {
  const client = await createClient('Coastal');
  const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  const kim = await createAssociate({ firstName: 'Kim', lastName: 'Nguyen' });
  await prisma.application.create({
    data: { associateId: kim.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' },
  });
  const { user: kimUser } = await createUser({ role: 'ASSOCIATE', associateId: kim.id });
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mikeA = await createAssociate({ firstName: 'Mike', lastName: 'Driver' });
  const { user: driver } = await createUser({ role: 'DRIVER', associateId: mikeA.id });
  const { user: otherDriver } = await createUser({ role: 'DRIVER' });
  const van = await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 2 } });
  const stop = await prisma.transportStop.create({ data: { name: 'Seaside Housing', address: '100 Gulf Blvd, Destin FL' } });
  return {
    client,
    store,
    kim,
    kimAgent: await loginAs(kimUser.email),
    kimUser,
    director,
    directorAgent: await loginAs(director.email),
    driver,
    driverAgent: await loginAs(driver.email),
    otherDriver,
    van,
    stop,
  };
}

async function book(agent: TestAgent<Test>, body: Record<string, unknown>) {
  return agent.post('/transport/me/rides').send(body);
}

describe('picking a pickup, not typing one', () => {
  // Typing was the accuracy hole: an unrecognised address was accepted,
  // stored without coordinates, and only became a problem at 6am when it
  // showed up in the driver's stop list as a row with no pin. Every
  // suggestion carries its own point, so a pickup chosen from one is
  // mappable by construction — and anything that still isn't gets refused
  // while the rider is looking at the form and can fix it.
  it('refuses an address it cannot place, and says what to do instead', async () => {
    const { kimAgent, store } = await seed();
    await kimAgent.post('/transport/me/consent');
    setGeocoderForTests(async () => null); // nothing typed gets found

    const res = await book(kimAgent, {
      direction: 'TO_WORK',
      locationId: store.id,
      address: '900 Nowhere Rd',
      targetAt: inHours(20).toISOString(),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('pickup_not_located');
    expect(res.body.error.message).toMatch(/suggestions|current location|drop a pin/i);
    expect(await prisma.ride.count()).toBe(0);
  });

  it('takes the point the picker already found, without a lookup of its own', async () => {
    const { kimAgent, store } = await seed();
    await kimAgent.post('/transport/me/consent');
    // A suggestion arrives with coordinates attached, so this must book
    // even when the geocoder is having a bad day.
    setGeocoderForTests(async () => null);

    const res = await book(kimAgent, {
      direction: 'TO_WORK',
      locationId: store.id,
      address: '7209 Thomas Dr, Panama City Beach FL',
      lat: 30.1766,
      lng: -85.8055,
      targetAt: inHours(20).toISOString(),
    });
    expect(res.status).toBe(201);
    const ride = await prisma.ride.findFirstOrThrow();
    expect(Number(ride.lat)).toBeCloseTo(30.1766, 4);
    expect(Number(ride.lng)).toBeCloseTo(-85.8055, 4);
  });

  it('suggests addresses near the store being booked against', async () => {
    const { kimAgent, store } = await seed();
    const seen: Array<{ q: string; near: unknown }> = [];
    setGeocoderForTests(null, null, async (q, near) => {
      seen.push({ q, near });
      return [
        { label: '7209 Thomas Dr', address: '7209 Thomas Dr, Panama City Beach FL', lat: 30.17, lng: -85.8, precision: 'exact' as const },
      ];
    });

    const res = await kimAgent.get(`/transport/me/ride-addresses?q=7209 Thomas&locationId=${store.id}`);
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ address: expect.stringContaining('Thomas Dr'), precision: 'exact' });
    expect(seen[0]!.q).toBe('7209 Thomas');

    // Too short to mean anything — and on Nominatim it would spend the
    // one-per-second budget on noise.
    expect((await kimAgent.get('/transport/me/ride-addresses?q=720')).body.results).toEqual([]);
  });

  it('looks up the building, not the apartment, and keeps the apartment on the address', async () => {
    const { kimAgent, store } = await seed();
    const seen: string[] = [];
    setGeocoderForTests(null, null, async (q) => {
      seen.push(q);
      return [
        { label: '382 Flamingo Drive', address: '382 Flamingo Drive, Destin, Florida 32541', lat: 30.4012, lng: -86.5003, precision: 'exact' as const },
      ];
    });

    const res = await kimAgent.get(
      `/transport/me/ride-addresses?q=${encodeURIComponent('382 Flamingo Dr #2')}&locationId=${store.id}`,
    );
    // Nominatim reads "#2" as house number 2 — a different house.
    expect(seen).toEqual(['382 Flamingo Dr']);
    // The driver still needs to know which door.
    expect(res.body.results[0]).toMatchObject({
      label: '382 Flamingo Drive #2',
      address: '382 Flamingo Drive #2, Destin, Florida 32541',
    });
  });

  // Riders book from work. "Use where I am now" there is the store they
  // are booking a ride TO, and it was taken as home without a word —
  // reported as "it keeps giving me Walmart's address".
  it('says when "where I am" is the store itself, rather than calling it home', async () => {
    const { kimAgent, store } = await seed();
    await prisma.location.update({ where: { id: store.id }, data: { latitude: 30.3925, longitude: -86.4128 } });
    let reversed = 0;
    setGeocoderForTests(null, async () => {
      reversed += 1;
      return '382 Flamingo Drive, Destin, Florida 32541';
    });

    const atWork = await kimAgent.get(`/transport/me/where?lat=30.3928&lng=-86.4131&locationId=${store.id}`);
    expect(atWork.body).toEqual({ address: null, atStore: true });
    expect(reversed).toBe(0);

    const atHome = await kimAgent.get(`/transport/me/where?lat=30.4012&lng=-86.5003&locationId=${store.id}`);
    expect(atHome.body).toEqual({ address: '382 Flamingo Drive, Destin, Florida 32541', atStore: false });
  });

  it('refuses a pickup at the store being booked to, whichever way it arrived', async () => {
    const { kimAgent, store } = await seed();
    await kimAgent.post('/transport/me/consent');
    await prisma.location.update({ where: { id: store.id }, data: { latitude: 30.3925, longitude: -86.4128 } });
    const ride = { direction: 'TO_WORK', locationId: store.id, targetAt: inHours(20).toISOString() };

    const fromGps = await book(kimAgent, { ...ride, address: '15017 Emerald Coast Pkwy, Destin, FL', lat: 30.3926, lng: -86.4127 });
    expect(fromGps.status).toBe(422);
    expect(fromGps.body.error.code).toBe('pickup_at_store');
    expect(fromGps.body.error.message).toMatch(/where you live/);

    // A "Home" saved from the phone's fix at work would carry the store's
    // point into every booking after it.
    const saved = await kimAgent
      .post('/transport/me/places')
      .send({ label: 'Home', address: '15017 Emerald Coast Pkwy, Destin, FL', lat: 30.3927, lng: -86.413 });
    expect((await book(kimAgent, { ...ride, placeId: saved.body.place.id })).body.error.code).toBe('pickup_at_store');
    expect(await prisma.ride.count()).toBe(0);

    // Home, eight kilometres off, books as it always did.
    const home = await book(kimAgent, { ...ride, address: '382 Flamingo Drive, Destin, FL', lat: 30.4012, lng: -86.5003 });
    expect(home.status).toBe(201);
  });

  it('never refuses on a store point that was only looked up — it can land mid-road', async () => {
    const { kimAgent, store } = await seed();
    await kimAgent.post('/transport/me/consent');
    // An address and no geofence: the store's point is the geocoder's
    // guess, which this test's geocoder puts right on the rider's door.
    await prisma.location.update({
      where: { id: store.id },
      data: { addressLine1: '15017 Emerald Coast Pkwy', city: 'Destin', state: 'FL', zip: '32541' },
    });
    const res = await book(kimAgent, {
      direction: 'TO_WORK',
      locationId: store.id,
      address: '14 Calhoun Ave, Destin, FL',
      lat: 30.39,
      lng: -86.49,
      targetAt: inHours(20).toISOString(),
    });
    expect(res.status).toBe(201);
  });
});

describe('the Ride tab — booking a seat', () => {
  it('asks for the charge authorization first, then books at least 10 hours ahead — no shift needed', async () => {
    const { kimAgent, store, stop } = await seed();
    const body = { direction: 'TO_WORK', locationId: store.id, stopId: stop.id, targetAt: inHours(20).toISOString() };
    expect((await book(kimAgent, body)).body.error.code).toBe('consent_required');

    expect((await kimAgent.post('/transport/me/consent')).status).toBe(201);
    const tooLate = await book(kimAgent, { ...body, targetAt: inHours(6).toISOString() });
    expect(tooLate.status).toBe(400);
    expect(tooLate.body.error.message).toMatch(/at least 10 hours ahead/);

    const ok = await book(kimAgent, body);
    expect(ok.status).toBe(201);
    expect(ok.body.ride).toMatchObject({
      direction: 'TO_WORK',
      status: 'REQUESTED',
      fareCents: 500,
      noShowFeeCents: 100,
      pickup: { kind: 'stop', name: 'Seaside Housing' },
      store: { id: store.id },
    });
    // Same way, same time — it's a duplicate.
    expect((await book(kimAgent, body)).body.error.code).toBe('duplicate');

    const me = await kimAgent.get('/transport/me');
    expect(me.body.settings).toEqual({ fareCents: 500, noShowFeeCents: 100, cutoffHours: 10 });
    expect(me.body.rides).toHaveLength(1);
    expect(me.body.stores.map((s: { id: string }) => s.id)).toContain(store.id);
  });

  it('only to their own stores; from a saved home address works too', async () => {
    const { kimAgent, store } = await seed();
    await kimAgent.post('/transport/me/consent');
    const other = await createClient('Target');
    const otherStore = await prisma.location.findFirstOrThrow({ where: { clientId: other.id } });
    const denied = await book(kimAgent, {
      direction: 'TO_WORK',
      locationId: otherStore.id,
      address: '12 Oak St, Destin FL',
      targetAt: inHours(20).toISOString(),
    });
    expect(denied.body.error.code).toBe('store_not_allowed');

    const place = await kimAgent.post('/transport/me/places').send({ label: 'Home', address: '12 Oak St, Destin FL' });
    const fromHome = await book(kimAgent, {
      direction: 'FROM_WORK',
      locationId: store.id,
      placeId: place.body.place.id,
      targetAt: inHours(30).toISOString(),
    });
    expect(fromHome.status).toBe(201);
    expect(fromHome.body.ride.pickup).toMatchObject({ kind: 'address', address: '12 Oak St, Destin FL' });
  });

  it('a supervisor sees who is arriving by van — and who has no shift — as a heads-up only', async () => {
    const { kimAgent, store, stop, client } = await seed();
    await kimAgent.post('/transport/me/consent');
    await book(kimAgent, { direction: 'TO_WORK', locationId: store.id, stopId: stop.id, targetAt: inHours(12).toISOString() });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const arrivals = await (await loginAs(sup.email)).get('/transport/arrivals');
    expect(arrivals.status).toBe(200);
    expect(arrivals.body.arrivals).toEqual([
      expect.objectContaining({ name: 'Kim Nguyen', hasShift: false, status: 'REQUESTED' }),
    ]);
  });
});

describe('dispatch → the driver → the charge', () => {
  async function bookedAndDispatched() {
    const s = await seed();
    await s.kimAgent.post('/transport/me/consent');
    const targetAt = inHours(20);
    const ride = (
      await book(s.kimAgent, { direction: 'TO_WORK', locationId: s.store.id, stopId: s.stop.id, targetAt: targetAt.toISOString() })
    ).body.ride;
    const serviceDate = ride.serviceDate;
    const run = await s.directorAgent.post('/transport/runs').send({
      vanId: s.van.id,
      driverUserId: s.driver.id,
      direction: 'TO_WORK',
      serviceDate,
      departAt: new Date(targetAt.getTime() - 60 * 60_000).toISOString(),
      rides: [{ rideId: ride.id, pickupAt: new Date(targetAt.getTime() - 40 * 60_000).toISOString() }],
    });
    expect(run.status).toBe(201);
    return { ...s, ride, run: run.body.run };
  }

  it('the director puts the booking on a van; the rider hears the van, the time, and the driver', async () => {
    const { run, kimUser, kimAgent } = await bookedAndDispatched();
    expect(run).toMatchObject({ status: 'PLANNED', van: { name: 'Van 1' }, seats: { taken: 1, capacity: 2 } });
    expect(run.rides[0]).toMatchObject({ status: 'SCHEDULED', pickupOrder: 1 });
    await flushPendingNotifications();
    const told = await prisma.notification.findFirst({
      where: { recipientUserId: kimUser.id, channel: 'IN_APP', subject: { startsWith: 'Your van: Van 1' } },
    });
    expect(told?.body).toMatch(/Seaside Housing — Van 1 \(ALT 101\), driver Mike/);
    // Associates can't dispatch.
    expect((await kimAgent.post('/transport/runs').send({})).status).toBe(403);
  });

  it("won't overfill a van", async () => {
    const s = await seed();
    const extra = await Promise.all(
      ['A', 'B', 'C'].map(async (n) => {
        const a = await createAssociate({ firstName: n, lastName: 'Rider' });
        return prisma.ride.create({
          data: {
            associateId: a.id,
            direction: 'TO_WORK',
            locationId: s.store.id,
            stopId: s.stop.id,
            targetAt: inHours(20),
            serviceDate: '2099-01-01',
            fareCents: 500,
            noShowFeeCents: 100,
            createdById: s.director.id,
          },
        });
      }),
    );
    const res = await s.directorAgent.post('/transport/runs').send({
      vanId: s.van.id,
      driverUserId: s.driver.id,
      direction: 'TO_WORK',
      serviceDate: '2099-01-01',
      departAt: inHours(19).toISOString(),
      rides: extra.map((r) => ({ rideId: r.id, pickupAt: inHours(19).toISOString() })),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('over_capacity');
  });

  it('the driver marks on board ($5) — only their own run — and completes it', async () => {
    const { ride, run, driverAgent, otherDriver } = await bookedAndDispatched();
    const other = await loginAs(otherDriver.email);
    expect((await other.post(`/transport/driver/rides/${ride.id}/board`)).status).toBe(404);

    const mine = await driverAgent.get('/transport/driver/runs');
    expect(mine.body.runs.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect((await driverAgent.post(`/transport/driver/runs/${run.id}/complete`)).body.error.code).toBe('not_active');

    const boarded = await driverAgent.post(`/transport/driver/rides/${ride.id}/board`);
    expect(boarded.body.ride).toMatchObject({ status: 'BOARDED', owedCents: 500 });
    expect((await prisma.rideRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('ACTIVE');
    const done = await driverAgent.post(`/transport/driver/runs/${run.id}/complete`);
    expect(done.body.run.status).toBe('COMPLETED');
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).status).toBe('COMPLETED');
  });

  it('a no-show owes $1 and hears about it — only after the van arrived and waited 3 minutes', async () => {
    const { ride, run, driverAgent, kimUser } = await bookedAndDispatched();
    // The van never stopped: no charge possible.
    expect((await driverAgent.post(`/transport/driver/rides/${ride.id}/no-show`)).body.error.code).toBe('not_arrived');
    const arrived = await driverAgent.post(`/transport/driver/runs/${run.id}/arrived`).send({ rideIds: [ride.id] });
    expect(arrived.status).toBe(200);
    expect(arrived.body.run.status).toBe('ACTIVE');
    await flushPendingNotifications();
    const here = await prisma.notification.findFirst({
      where: { recipientUserId: kimUser.id, channel: 'IN_APP', subject: 'Your van is here' },
    });
    expect(here?.body).toMatch(/Van 1 \(ALT 101\) is at Seaside Housing\. Mike will wait 3 minutes\./);
    // Inside the 3 minutes: not yet.
    const early = await driverAgent.post(`/transport/driver/rides/${ride.id}/no-show`);
    expect(early.body.error.code).toBe('still_waiting');
    expect(early.body.error.message).toMatch(/riders get 3 minutes after you arrive/);
    await prisma.ride.update({ where: { id: ride.id }, data: { vanArrivedAt: new Date(Date.now() - 4 * 60_000) } });
    const res = await driverAgent.post(`/transport/driver/rides/${ride.id}/no-show`);
    expect(res.body.ride).toMatchObject({ status: 'NO_SHOW', owedCents: 100 });
    await flushPendingNotifications();
    const told = await prisma.notification.findFirst({
      where: { recipientUserId: kimUser.id, channel: 'IN_APP', subject: 'Missed your van' },
    });
    expect(told?.body).toMatch(/\$1\.00 no-show fee/);
  });

  it('cancelling is free until the van leaves; the driver hears; after it leaves, it stays', async () => {
    const { ride, run, kimAgent, driver, driverAgent } = await bookedAndDispatched();
    // Van on its way → too late to cancel.
    await driverAgent.post(`/transport/driver/runs/${run.id}/start`);
    expect((await kimAgent.post(`/transport/me/rides/${ride.id}/cancel`)).body.error.code).toBe('van_departed');
    await prisma.rideRun.update({ where: { id: run.id }, data: { status: 'PLANNED' } });
    expect((await kimAgent.post(`/transport/me/rides/${ride.id}/cancel`)).status).toBe(200);
    await flushPendingNotifications();
    expect(
      await prisma.notification.findFirst({
        where: { recipientUserId: driver.id, channel: 'IN_APP', subject: { startsWith: 'Kim cancelled' } },
      }),
    ).not.toBeNull();
  });

  it('the director cancels a run: its riders go back to needing a van', async () => {
    const { ride, run, directorAgent } = await bookedAndDispatched();
    expect((await directorAgent.post(`/transport/runs/${run.id}/cancel`).send({ reason: 'Van in the shop' })).status).toBe(200);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).status).toBe('REQUESTED');
    const board = await directorAgent.get(`/transport/board?date=${ride.serviceDate}`);
    expect(board.body.kpis).toMatchObject({ needsVan: 1, runs: 0 });
  });
});

describe('ride charges come out of the pay period’s paycheck', () => {
  it('fares and no-show fees in the period are one post-tax deduction; waived and later rides wait', async () => {
    const client = await createClient();
    const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date('2026-04-14T13:00:00.000Z'),
        clockOutAt: new Date('2026-04-14T17:00:00.000Z'), // 4h
        status: 'APPROVED',
      },
    });
    const ride = (serviceDate: string, status: 'COMPLETED' | 'NO_SHOW', chargeCents: number, extra: Record<string, unknown> = {}) =>
      prisma.ride.create({
        data: {
          associateId: associate.id,
          direction: 'TO_WORK',
          locationId: store.id,
          address: '12 Oak St',
          targetAt: new Date(`${serviceDate}T13:00:00.000Z`),
          serviceDate,
          status,
          fareCents: 500,
          noShowFeeCents: 100,
          chargeCents,
          createdById: hr.id,
          ...extra,
        },
      });
    const r1 = await ride('2026-04-14', 'COMPLETED', 500);
    const r2 = await ride('2026-04-15', 'COMPLETED', 500);
    const r3 = await ride('2026-04-16', 'NO_SHOW', 100);
    await ride('2026-04-16', 'COMPLETED', 500, { waivedAt: new Date(), waiveReason: 'Van was late' });
    const later = await ride('2026-04-25', 'COMPLETED', 500);

    const a = await loginAs(hr.email);
    const res = await a.post('/payroll/runs').send({ periodStart: '2026-04-13', periodEnd: '2026-04-19', defaultHourlyRate: 25 });
    expect(res.status).toBe(201);
    const item = res.body.items[0];
    expect(item.grossPay).toBe(100);
    expect(item.postTaxDeductions).toBeCloseTo(11, 2);
    const taxes = item.federalWithholding + item.fica + item.medicare + item.stateWithholding;
    expect(item.netPay).toBeCloseTo(100 - taxes - 11, 2);

    const taken = await prisma.ride.findMany({ where: { chargedRunId: res.body.id }, select: { id: true } });
    expect(taken.map((r) => r.id).sort()).toEqual([r1.id, r2.id, r3.id].sort());
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: later.id } })).chargedRunId).toBeNull();

    // The associate's paystub names it: its own line, and year to date.
    await prisma.payrollItem.update({
      where: { id: item.id },
      data: { status: 'DISBURSED', disbursedAt: new Date('2026-04-24T12:00:00.000Z') },
    });
    const { user: mine } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
    const me = await loginAs(mine.email);
    const stubs = await me.get('/payroll/me/items');
    expect(stubs.status).toBe(200);
    const stub = (stubs.body.items as Array<{ id: string; transport?: unknown }>).find((i) => i.id === item.id);
    expect(stub?.transport).toEqual({ amount: 11, rides: 2, noShows: 1 });
    const ytd = await me.get(`/payroll/me/items/${item.id}/ytd`);
    expect(ytd.status).toBe(200);
    expect(ytd.body.transport).toBeCloseTo(11, 2);
    expect(ytd.body.postTaxDeductions).toBeCloseTo(11, 2);
  });
});

describe('who rides where', () => {
  it('an associate on the schedule at a client rides to its stores, even before their application is approved', async () => {
    const client = await createClient('Seaside');
    const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: store.id,
        position: 'Server',
        startsAt: inHours(30),
        endsAt: inHours(38),
        status: 'ASSIGNED',
        assignedAssociateId: maria.id,
      },
    });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: maria.id });
    const agent = await loginAs(user.email);
    await agent.post('/transport/me/consent');
    const me = await agent.get('/transport/me');
    expect(me.body.stores.map((s: { id: string }) => s.id)).toEqual([store.id]);
  });
});

describe('supervisors ride too', () => {
  it('a shift supervisor books a ride to a store of their own client, without an application there', async () => {
    const client = await createClient('Coastal');
    const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const dana = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: dana.id });
    const agent = await loginAs(sup.email);
    await agent.post('/transport/me/consent');
    const me = await agent.get('/transport/me');
    expect(me.body.stores.map((s: { id: string }) => s.id)).toContain(store.id);
    const ok = await book(agent, {
      direction: 'TO_WORK',
      locationId: store.id,
      address: '9 Harbor Rd, Destin FL',
      targetAt: inHours(20).toISOString(),
    });
    expect(ok.status).toBe(201);
  });
});

describe('the pickup handshake and one-tap booking', () => {
  it('the rider tells the driver "I\u2019m outside" or "running late" once the van is on its way', async () => {
    const s = await seed();
    await s.kimAgent.post('/transport/me/consent');
    const targetAt = inHours(20);
    const ride = (
      await book(s.kimAgent, { direction: 'TO_WORK', locationId: s.store.id, stopId: s.stop.id, targetAt: targetAt.toISOString() })
    ).body.ride;
    // Not on a van yet.
    expect((await s.kimAgent.post(`/transport/me/rides/${ride.id}/signal`).send({ kind: 'OUTSIDE' })).body.error.code).toBe(
      'not_on_the_way',
    );
    const run = await s.directorAgent.post('/transport/runs').send({
      vanId: s.van.id,
      driverUserId: s.driver.id,
      direction: 'TO_WORK',
      serviceDate: ride.serviceDate,
      departAt: new Date(targetAt.getTime() - 60 * 60_000).toISOString(),
      rides: [{ rideId: ride.id, pickupAt: new Date(targetAt.getTime() - 40 * 60_000).toISOString() }],
    });
    await s.driverAgent.post(`/transport/driver/runs/${run.body.run.id}/start`);
    expect((await s.kimAgent.post(`/transport/me/rides/${ride.id}/signal`).send({ kind: 'LATE' })).status).toBe(200);
    await flushPendingNotifications();
    const told = await prisma.notification.findFirst({
      where: { recipientUserId: s.driver.id, channel: 'IN_APP', subject: 'Kim is running a few minutes late' },
    });
    expect(told?.body).toMatch(/Seaside Housing/);
    const runs = await s.driverAgent.get('/transport/driver/runs');
    expect(runs.body.runs[0].rides[0].riderSignal).toMatchObject({ kind: 'LATE' });
  });

  it('remembers where they went last — the pickup and the store — for one-tap booking', async () => {
    const s = await seed();
    await s.kimAgent.post('/transport/me/consent');
    const before = await s.kimAgent.get('/transport/me');
    expect(before.body.defaultPickup).toBeNull();
    expect(before.body.defaultStoreId).toBe(s.store.id);

    await book(s.kimAgent, { direction: 'TO_WORK', locationId: s.store.id, stopId: s.stop.id, targetAt: inHours(20).toISOString() });
    expect((await s.kimAgent.get('/transport/me')).body.defaultPickup).toEqual({
      kind: 'stop',
      stopId: s.stop.id,
      label: 'Seaside Housing',
    });

    const place = await s.kimAgent.post('/transport/me/places').send({ label: 'Home', address: '12 Oak St, Destin FL' });
    await book(s.kimAgent, { direction: 'FROM_WORK', locationId: s.store.id, placeId: place.body.place.id, targetAt: inHours(30).toISOString() });
    expect((await s.kimAgent.get('/transport/me')).body.defaultPickup).toEqual({
      kind: 'place',
      placeId: place.body.place.id,
      label: 'Home',
    });
  });
});

