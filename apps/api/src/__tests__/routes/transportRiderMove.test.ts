import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { MoveRideResult, RideShareLink } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { setGeocoderForTests } from '../../lib/geocode.js';
import { setRoutingForTests } from '../../lib/mapboxRouting.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import { PRE_TRIP_ITEMS } from '../../lib/transportDrivers.js';
import { cheapestSlot } from '../../lib/transportMove.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The rider's side and the desk's move (transport upgrade 2026-10-28):
 *   POST /transport/rides/:id/move        a rider onto another run, or back
 *                                         to "needs a van" — timed the
 *                                         planner's way, never past the seats
 *   POST /transport/me/rides/:id/share    the rider's link: the van and its
 *                                         ETA to their stop, nothing else
 *   GET  /transport/me/live               who to look for, where to wait,
 *                                         how long the van waits, the fare
 *   one walk-around per van per day       a passed pre-trip covers the van's
 *                                         afternoon run too
 */

const ALTO = '00000000-0000-4000-8000-000000000001';
const M = 60_000;
const STORE = { lat: 30.1766, lng: -85.8055 };
const SEASIDE = { lat: 30.2106, lng: -85.865 };
const HARBOR = { lat: 30.25, lng: -85.9 };
const FAR = { lat: 30.3, lng: -85.95 };

beforeEach(async () => {
  await truncateAll();
  await prisma.transportSettings.upsert({ where: { tenantId: ALTO }, create: { preTripRequired: false, dispatchPhone: '(850) 555-0199' }, update: { preTripRequired: false, dispatchPhone: '(850) 555-0199' } });
  setGeocoderForTests(async () => null);
  setRoutingForTests(null);
});
afterEach(() => {
  setGeocoderForTests(null);
  setRoutingForTests(undefined);
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

async function fleet() {
  const now = pinMidweekNoon();
  const at = (min: number) => new Date(now.getTime() + min * M);
  const client = await createClient('Gulf Pines');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const store = await prisma.site.update({ where: { id: site.id }, data: { name: 'Gulf Pines', latitude: STORE.lat, longitude: STORE.lng } });
  const today = dateKeyInZone(now, store.timezone);
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mikeA = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  await prisma.associate.update({ where: { id: mikeA.id }, data: { phone: '(850) 555-0101' } });
  const { user: mike } = await createUser({ role: 'DRIVER', associateId: mikeA.id });
  const leeA = await createAssociate({ firstName: 'Lee', lastName: 'Park' });
  const { user: lee } = await createUser({ role: 'DRIVER', associateId: leeA.id });
  const van1 = await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 3, make: 'Ford', model: 'Transit', color: 'White', year: 2023 } });
  const van2 = await prisma.van.create({ data: { name: 'Van 2', plate: 'ALT 102', capacity: 12 } });
  const stop = await prisma.transportStop.create({ data: { name: 'Seaside Housing', address: '100 Gulf Blvd', ...SEASIDE, notes: 'By the front gate, under the awning' } });

  async function rider(firstName: string, o: { direction?: 'TO_WORK' | 'FROM_WORK'; targetAt?: Date; status?: 'REQUESTED' | 'SCHEDULED' | 'BOARDED'; runId?: string; pickupAt?: Date; pickupOrder?: number; home?: { lat: number; lng: number }; stopId?: string; language?: string; lastName?: string } = {}) {
    const a = await createAssociate({ firstName, lastName: o.lastName ?? 'Rider' });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    if (o.language) await prisma.user.update({ where: { id: user.id }, data: { language: o.language } });
    const targetAt = o.targetAt ?? at(120);
    const home = o.home ?? HARBOR;
    const ride = await prisma.ride.create({
      data: {
        associateId: a.id,
        direction: o.direction ?? 'TO_WORK',
        locationId: store.id,
        ...(o.stopId ? { stopId: o.stopId } : { address: `${firstName}'s house, 9 Harbor Rd`, lat: home.lat, lng: home.lng }),
        targetAt,
        serviceDate: dateKeyInZone(targetAt, store.timezone),
        status: o.status ?? 'REQUESTED',
        runId: o.runId ?? null,
        pickupOrder: o.pickupOrder ?? null,
        pickupAt: o.pickupAt ?? null,
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: director.id,
      },
    });
    return { associate: a, user, ride, agent: () => loginAs(user.email) };
  }
  async function run(o: { vanId: string; driverUserId: string; departAt: Date; direction?: 'TO_WORK' | 'FROM_WORK'; status?: 'PLANNED' | 'ACTIVE' }) {
    return prisma.rideRun.create({
      data: {
        vanId: o.vanId,
        driverUserId: o.driverUserId,
        direction: o.direction ?? 'TO_WORK',
        serviceDate: dateKeyInZone(o.departAt, store.timezone),
        departAt: o.departAt,
        status: o.status ?? 'PLANNED',
        startedAt: o.status === 'ACTIVE' ? o.departAt : null,
        createdById: director.id,
      },
    });
  }
  return { now, at, client, store, stop, today, director, mike, lee, van1, van2, rider, run, desk: await loginAs(director.email) };
}

const rideRow = (id: string) => prisma.ride.findUniqueOrThrow({ where: { id } });

describe('POST /transport/rides/:id/move', () => {
  it('puts a waiting rider on a run, timed the planner’s way, slotted where it costs least — and tells them', async () => {
    const f = await fleet();
    const r = await f.run({ vanId: f.van2.id, driverUserId: f.mike.id, departAt: f.at(30) });
    // Two on the run already: the far one first, then Seaside; Kim lives between them.
    const far = await f.rider('Far', { status: 'SCHEDULED', runId: r.id, pickupOrder: 1, pickupAt: f.at(50), home: FAR });
    const sea = await f.rider('Sea', { status: 'SCHEDULED', runId: r.id, pickupOrder: 2, pickupAt: f.at(70), home: SEASIDE });
    const kim = await f.rider('Kim', { home: HARBOR });
    const res = await f.desk.post(`/transport/rides/${kim.ride.id}/move`).send({ toRunId: r.id });
    expect(res.status).toBe(200);
    expect(res.body as MoveRideResult).toEqual({ rideId: kim.ride.id, fromRunId: null, toRunId: r.id, seats: { taken: 3, capacity: 12 }, warnings: [] });
    const [a, b, c] = await Promise.all([rideRow(far.ride.id), rideRow(kim.ride.id), rideRow(sea.ride.id)]);
    expect([a.pickupOrder, b.pickupOrder, c.pickupOrder]).toEqual([1, 2, 3]);
    expect(b).toMatchObject({ status: 'SCHEDULED', runId: r.id, acceptedById: f.director.id });
    // Worked back from the place, 5 minutes before the arrive-by: each pickup earlier than the next.
    expect(a.pickupAt!.getTime()).toBeLessThan(b.pickupAt!.getTime());
    expect(b.pickupAt!.getTime()).toBeLessThan(c.pickupAt!.getTime());
    expect(c.pickupAt!.getTime()).toBeLessThan(f.at(115).getTime());
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'transport.ride_moved', entityId: kim.ride.id } })).toBe(1);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: kim.user.id, channel: 'IN_APP', subject: { startsWith: 'Your van: Van 2' } } })).toBe(1);
  });

  it('honours the desk’s chosen place in the order', async () => {
    const f = await fleet();
    const r = await f.run({ vanId: f.van2.id, driverUserId: f.mike.id, departAt: f.at(30) });
    const one = await f.rider('One', { status: 'SCHEDULED', runId: r.id, pickupOrder: 1, pickupAt: f.at(50), home: FAR });
    const two = await f.rider('Two', { status: 'SCHEDULED', runId: r.id, pickupOrder: 2, pickupAt: f.at(70), home: SEASIDE });
    const kim = await f.rider('Kim', { home: HARBOR });
    expect((await f.desk.post(`/transport/rides/${kim.ride.id}/move`).send({ toRunId: r.id, pickupOrder: 1 })).status).toBe(200);
    expect((await rideRow(kim.ride.id)).pickupOrder).toBe(1);
    expect((await rideRow(one.ride.id)).pickupOrder).toBe(2);
    expect((await rideRow(two.ride.id)).pickupOrder).toBe(3);
  });

  it('moves a rider between runs, renumbers the run left behind, warns when the van is now full — and refuses past the seats', async () => {
    const f = await fleet();
    const from = await f.run({ vanId: f.van2.id, driverUserId: f.lee.id, departAt: f.at(30) });
    const to = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(35) }); // Van 1 seats 3
    const a = await f.rider('A', { status: 'SCHEDULED', runId: from.id, pickupOrder: 1, pickupAt: f.at(50) });
    const b = await f.rider('B', { status: 'SCHEDULED', runId: from.id, pickupOrder: 2, pickupAt: f.at(60) });
    await f.rider('C', { status: 'SCHEDULED', runId: to.id, pickupOrder: 1, pickupAt: f.at(50) });
    await f.rider('D', { status: 'SCHEDULED', runId: to.id, pickupOrder: 2, pickupAt: f.at(60) });
    const res = await f.desk.post(`/transport/rides/${a.ride.id}/move`).send({ toRunId: to.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fromRunId: from.id, toRunId: to.id, seats: { taken: 3, capacity: 3 }, warnings: ['Van 1 is now at 3 of 3 seats.'] });
    expect((await rideRow(b.ride.id)).pickupOrder).toBe(1);
    // Full: B is refused, with the reason in words, and nothing moved.
    const refused = await f.desk.post(`/transport/rides/${b.ride.id}/move`).send({ toRunId: to.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'over_capacity', message: "Van 1 seats 3 and already has 3 riders — there's no seat for B Rider." });
    expect(await rideRow(b.ride.id)).toMatchObject({ runId: from.id, status: 'SCHEDULED' });
    // The run left empty is said.
    const last = await f.desk.post(`/transport/rides/${b.ride.id}/move`).send({ toRunId: null });
    expect(last.body.warnings).toEqual(["Van 2's run has no riders left — cancel it if it isn't needed."]);
  });

  it('refuses the wrong way or another day, a run that has left, and a ride already on board', async () => {
    const f = await fleet();
    const home = await f.run({ vanId: f.van2.id, driverUserId: f.mike.id, departAt: f.at(300), direction: 'FROM_WORK' });
    const kim = await f.rider('Kim');
    const wrong = await f.desk.post(`/transport/rides/${kim.ride.id}/move`).send({ toRunId: home.id });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatchObject({ code: 'ride_mismatch', message: "Kim Rider is going to work; Van 2's run goes home." });
    const tomorrow = await f.run({ vanId: f.van2.id, driverUserId: f.mike.id, departAt: f.at(24 * 60) });
    expect((await f.desk.post(`/transport/rides/${kim.ride.id}/move`).send({ toRunId: tomorrow.id })).body.error.code).toBe('ride_mismatch');
    const gone = await f.run({ vanId: f.van1.id, driverUserId: f.lee.id, departAt: f.at(-10), status: 'ACTIVE' });
    expect((await f.desk.post(`/transport/rides/${kim.ride.id}/move`).send({ toRunId: gone.id })).body.error.code).toBe('run_left');
    const onBoard = await f.rider('Bo', { status: 'BOARDED', runId: gone.id });
    expect((await f.desk.post(`/transport/rides/${onBoard.ride.id}/move`).send({ toRunId: null })).body.error.code).toBe('ride_closed');
    expect(await rideRow(kim.ride.id)).toMatchObject({ status: 'REQUESTED', runId: null });
  });

  it('sends a rider back to "needs a van" and tells them', async () => {
    const f = await fleet();
    const r = await f.run({ vanId: f.van2.id, driverUserId: f.mike.id, departAt: f.at(30) });
    const kim = await f.rider('Kim', { status: 'SCHEDULED', runId: r.id, pickupOrder: 1, pickupAt: f.at(50) });
    const res = await f.desk.post(`/transport/rides/${kim.ride.id}/move`).send({ toRunId: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fromRunId: r.id, toRunId: null, seats: null });
    expect(await rideRow(kim.ride.id)).toMatchObject({ status: 'REQUESTED', runId: null, pickupOrder: null, pickupAt: null });
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: kim.user.id, channel: 'IN_APP', subject: 'Your van changed' } })).toBe(1);
  });

  it('is the desk’s: an associate or a driver can’t move anyone', async () => {
    const f = await fleet();
    const r = await f.run({ vanId: f.van2.id, driverUserId: f.mike.id, departAt: f.at(30) });
    const kim = await f.rider('Kim');
    expect((await (await kim.agent()).post(`/transport/rides/${kim.ride.id}/move`).send({ toRunId: r.id })).status).toBe(403);
    expect((await (await loginAs(f.mike.email)).post(`/transport/rides/${kim.ride.id}/move`).send({ toRunId: r.id })).status).toBe(403);
  });

  it('slots a pickup where the detour is shortest (lib/transportMove cheapestSlot)', () => {
    // To work: far → near → the place; a point between far and near goes between them.
    expect(cheapestSlot([FAR, SEASIDE], HARBOR, STORE, 'TO_WORK')).toBe(1);
    // A point beyond the far one goes first.
    expect(cheapestSlot([HARBOR, SEASIDE], { lat: 30.35, lng: -86 }, STORE, 'TO_WORK')).toBe(0);
    // Without a map point: last.
    expect(cheapestSlot([FAR, SEASIDE], null, STORE, 'TO_WORK')).toBe(2);
  });
});

describe('POST /transport/me/rides/:id/share', () => {
  it('gives the rider a link to their own ride — the van and the ETA to their stop, nothing else — for two hours past the run', async () => {
    const f = await fleet();
    const r = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(-20), status: 'ACTIVE' });
    await prisma.rideRun.update({ where: { id: r.id }, data: { lastLat: FAR.lat, lastLng: FAR.lng, lastLocationAt: f.at(0) } });
    const other = await f.rider('Olga', { status: 'SCHEDULED', runId: r.id, pickupOrder: 1, pickupAt: f.at(5), targetAt: f.at(60), home: SEASIDE, lastName: 'Secretname' });
    const kim = await f.rider('Kim', { status: 'SCHEDULED', runId: r.id, pickupOrder: 2, pickupAt: f.at(15), targetAt: f.at(60) });
    const res = await (await kim.agent()).post(`/transport/me/rides/${kim.ride.id}/share`);
    expect(res.status).toBe(200);
    const link = res.body as RideShareLink;
    expect(link.url).toMatch(/\/track\/[\w-]+\.[\w-]+$/);
    // The run should be over by two hours after it left (later than its last stop): the link lasts two hours more.
    expect(link.expiresAt).toBe(new Date(f.at(-20).getTime() + 4 * 3_600_000).toISOString());

    const token = link.url.split('/track/')[1]!;
    const view = await request(createApp()).get(`/transport/track/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.trip).toMatchObject({ status: 'ACTIVE', van: { name: 'Van 1', plate: 'ALT 101' }, driver: null, position: { lat: FAR.lat, lng: FAR.lng }, stopsLeft: 2 });
    expect(view.body.trip.next).toMatchObject({ kind: 'pickup', label: 'the pickup' });
    expect(view.body.trip.next.etaAt).toEqual(expect.any(String));
    const text = JSON.stringify(view.body);
    for (const leak of ['Kim', 'Olga', 'Secretname', 'Harbor', '100 Gulf Blvd', 'Mike', 'Chen', '(850) 555-0101', other.ride.id, kim.ride.id, String(SEASIDE.lat), `${HARBOR.lat},`, `${HARBOR.lng},`]) {
      expect(text).not.toContain(leak);
    }
    // Once Kim is aboard, the link counts down to where she gets off.
    await prisma.ride.update({ where: { id: kim.ride.id }, data: { status: 'BOARDED' } });
    expect((await request(createApp()).get(`/transport/track/${token}`)).body.trip.next).toMatchObject({ kind: 'store', label: 'Gulf Pines' });
    // Dropped off: the van is no longer shown.
    await prisma.ride.update({ where: { id: kim.ride.id }, data: { status: 'COMPLETED' } });
    expect((await request(createApp()).get(`/transport/track/${token}`)).body.trip).toMatchObject({ status: 'COMPLETED', position: null, next: null });
  });

  it('is the rider’s own ride only (404), and only once it is on a van (409)', async () => {
    const f = await fleet();
    const r = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(30) });
    const kim = await f.rider('Kim', { status: 'SCHEDULED', runId: r.id, pickupOrder: 1, pickupAt: f.at(50) });
    const ana = await f.rider('Ana');
    const anaAgent = await ana.agent();
    expect((await anaAgent.post(`/transport/me/rides/${kim.ride.id}/share`)).status).toBe(404);
    const noRun = await anaAgent.post(`/transport/me/rides/${ana.ride.id}/share`);
    expect(noRun.status).toBe(409);
    expect(noRun.body.error.code).toBe('no_run');
    // A planned run shares too: the van isn't shown until it leaves.
    const planned = await (await kim.agent()).post(`/transport/me/rides/${kim.ride.id}/share`);
    expect(planned.status).toBe(200);
    const trip = (await request(createApp()).get(`/transport/track/${(planned.body as RideShareLink).url.split('/track/')[1]}`)).body.trip;
    expect(trip).toMatchObject({ status: 'PLANNED', position: null });
    // Moved off that run: the old link stops.
    await prisma.ride.update({ where: { id: kim.ride.id }, data: { runId: null, status: 'REQUESTED' } });
    expect((await request(createApp()).get(`/transport/track/${(planned.body as RideShareLink).url.split('/track/')[1]}`)).status).toBe(410);
  });
});

describe('GET /transport/me/live — the card’s extras', () => {
  it('names the driver by first name, how the van looks, where to wait, the wait, the dispatch line and the fare', async () => {
    const f = await fleet();
    const r = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(30) });
    const kim = await f.rider('Kim', { status: 'SCHEDULED', runId: r.id, pickupOrder: 1, pickupAt: f.at(50), stopId: f.stop.id });
    const live = (await (await kim.agent()).get('/transport/me/live')).body.live;
    expect(live).toMatchObject({
      rideId: kim.ride.id,
      driverFirstName: 'Mike',
      vanLook: { color: 'White', make: 'Ford', model: 'Transit', year: 2023 },
      pickupNote: 'By the front gate, under the awning',
      waitMinutes: 3,
      dispatchPhone: '(850) 555-0199',
      // On no pay schedule: no date is promised.
      fare: { cents: 500, words: 'Taken from your pay' },
    });
    expect(JSON.stringify(live)).not.toContain('555-0101');
  });

  it('a ride with no van yet has no driver or van; a waived one is free; a Spanish rider reads Spanish', async () => {
    const f = await fleet();
    const ana = await f.rider('Ana', { language: 'es' });
    const live = (await (await ana.agent()).get('/transport/me/live')).body.live;
    expect(live).toMatchObject({ driverFirstName: null, vanLook: null, pickupNote: null, waitMinutes: 3, fare: { cents: 500, words: 'Se descuenta de su pago' } });
    await prisma.ride.update({ where: { id: ana.ride.id }, data: { waivedAt: new Date(), waiveReason: 'Promo' } });
    expect((await (await ana.agent()).get('/transport/me/live')).body.live.fare).toEqual({ cents: 0, words: 'Sin costo' });
  });

  it('says the payday the fare comes out on, from the rider’s pay schedule', async () => {
    const f = await fleet();
    const kim = await f.rider('Kim');
    // Biweekly Sat → Fri, paid the Friday after (offset 7), anchored on a recent Saturday.
    const anchor = new Date(`${f.today}T00:00:00Z`);
    anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 1) % 7));
    const schedule = await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: anchor, payDateOffsetDays: 7 } });
    await prisma.associate.update({ where: { id: kim.associate.id }, data: { payrollScheduleId: schedule.id } });
    const fare = (await (await kim.agent()).get('/transport/me/live')).body.live.fare;
    expect(fare.cents).toBe(500);
    expect(fare.words).toMatch(/^Taken from your pay on [A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe('one walk-around per van per day', () => {
  it('a passed pre-trip covers every run of that van that day; a later failed one parks it again', async () => {
    const f = await fleet();
    await prisma.transportSettings.update({ where: { tenantId: ALTO }, data: { preTripRequired: true } });
    const morning = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(10) });
    const afternoon = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(240), direction: 'FROM_WORK' });
    const mike = await loginAs(f.mike.email);
    const allOk = PRE_TRIP_ITEMS.map((i) => ({ key: i.key, ok: true }));
    expect((await mike.post(`/transport/driver/runs/${afternoon.id}/start`)).body.error.code).toBe('pretrip_required');
    expect((await mike.post(`/transport/driver/runs/${morning.id}/pre-trip`).send({ items: allOk })).status).toBe(201);
    const runs = (await mike.get('/transport/driver/runs')).body.runs as Array<{ id: string; preTripDone: boolean }>;
    expect(runs.find((r) => r.id === morning.id)!.preTripDone).toBe(true);
    expect(runs.find((r) => r.id === afternoon.id)!.preTripDone).toBe(true);
    const check = (await mike.get(`/transport/driver/runs/${afternoon.id}/pre-trip`)).body;
    expect(check).toMatchObject({ done: true, fromOtherRun: true, check: { passed: true } });
    // The afternoon run leaves on the morning's check.
    expect((await mike.post(`/transport/driver/runs/${afternoon.id}/start`)).status).toBe(200);

    // Another day's run of the same van needs its own.
    const tomorrow = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(24 * 60) });
    expect((await mike.post(`/transport/driver/runs/${tomorrow.id}/start`)).body.error.code).toBe('pretrip_required');
  });

  it('the van’s latest check decides: a failed one after a pass keeps the next run on the lot', async () => {
    const f = await fleet();
    await prisma.transportSettings.update({ where: { tenantId: ALTO }, data: { preTripRequired: true } });
    const first = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(10) });
    const second = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(240), direction: 'FROM_WORK' });
    const mike = await loginAs(f.mike.email);
    const allOk = PRE_TRIP_ITEMS.map((i) => ({ key: i.key, ok: true }));
    expect((await mike.post(`/transport/driver/runs/${first.id}/pre-trip`).send({ items: allOk })).status).toBe(201);
    const failed = await mike.post(`/transport/driver/runs/${second.id}/pre-trip`).send({ items: allOk.map((i) => (i.key === 'brakes' ? { ...i, ok: false } : i)) });
    expect(failed.body.passed).toBe(false);
    expect(((await mike.get('/transport/driver/runs')).body.runs as Array<{ id: string; preTripDone: boolean }>).every((r) => !r.preTripDone)).toBe(true);
    expect((await mike.post(`/transport/driver/runs/${second.id}/start`)).body.error.code).toBe('pretrip_required');
  });
});
