import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shareToken } from '../../lib/transportSafety.js';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { setRoutingForTests } from '../../lib/mapboxRouting.js';
import { PRE_TRIP_ITEMS, DRIVER_POSITION } from '../../lib/transportDrivers.js';
import { generateAllSeries } from '../../lib/rideSeries.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import { DEFAULT_TIMEZONE, zonedWallTimeToUtcInstant } from '../../lib/timezone.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The driver and fleet pack, end to end: the pre-trip check gates the run
 * and a failed safety item opens an issue; the SOS reaches the desk and
 * the desk acknowledges; a shared link shows the van and nothing about
 * who rides; an injury writes an OSHA incident and parks the van; the
 * rider's thumb; a standing booking books itself forward; the fleet
 * record and service log; a lapsed licence and the hours of service
 * refuse a dispatch; the desk's needs-you and the Inbox count agree.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
});
afterEach(() => setRoutingForTests(undefined));
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const STORE = { lat: 30.1766, lng: -85.8055 };
const SEASIDE = { lat: 30.2106, lng: -85.865 };
const allOk = () => PRE_TRIP_ITEMS.map((i) => ({ key: i.key, ok: true }));

async function fleet() {
  const client = await createClient('Coastal');
  const first = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const store = await prisma.site.update({ where: { id: first.id }, data: { latitude: STORE.lat, longitude: STORE.lng } });
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mike = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  const { user: driver } = await createUser({ role: 'DRIVER', associateId: mike.id });
  const van = await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 12, driverUserId: driver.id } });
  const targetAt = new Date(Date.now() + 90 * 60_000);
  targetAt.setSeconds(0, 0);
  const serviceDate = dateKeyInZone(targetAt, store.timezone);
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Rider' });
  await prisma.application.create({ data: { associateId: ana.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
  const run = await prisma.rideRun.create({
    data: { vanId: van.id, driverUserId: driver.id, direction: 'TO_WORK', serviceDate, departAt: new Date(targetAt.getTime() - 40 * 60_000), createdById: director.id },
  });
  const ride = await prisma.ride.create({
    data: {
      associateId: ana.id,
      direction: 'TO_WORK',
      locationId: store.id,
      address: '100 Gulf Blvd',
      ...SEASIDE,
      targetAt,
      serviceDate,
      status: 'SCHEDULED',
      runId: run.id,
      pickupOrder: 1,
      pickupAt: new Date(targetAt.getTime() - 30 * 60_000),
      fareCents: 500,
      noShowFeeCents: 100,
      createdById: director.id,
    },
  });
  return {
    client,
    store,
    director,
    directorAgent: await loginAs(director.email),
    driver,
    driverAgent: await loginAs(driver.email),
    mike,
    van,
    run,
    ride,
    ana,
    anaAgent: await loginAs(anaUser.email),
    targetAt,
    serviceDate,
  };
}

describe('the pre-trip check', () => {
  it('gates the run; a failed safety item opens a VEHICLE issue and keeps the van on the lot; a passed one lets it leave', async () => {
    const f = await fleet();
    const blocked = await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/start`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('pretrip_required');

    const failed = await f.driverAgent
      .post(`/transport/driver/runs/${f.run.id}/pre-trip`)
      .send({ items: allOk().map((i) => (i.key === 'brakes' ? { ...i, ok: false, note: 'grinding' } : i)), odometerMiles: 48_210 });
    expect(failed.status).toBe(201);
    expect(failed.body.passed).toBe(false);
    expect(failed.body.failedSafety).toEqual([{ key: 'brakes', label: 'Brakes' }]);
    expect(await prisma.transportIssue.count({ where: { category: 'VEHICLE', runId: f.run.id } })).toBe(1);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { channel: 'IN_APP', recipientUserId: f.director.id, subject: { startsWith: 'Pre-trip failed' } } })).toBe(1);
    const still = await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/start`);
    expect(still.status).toBe(409);

    const passed = await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/pre-trip`).send({ items: allOk(), odometerMiles: 48_212 });
    expect(passed.status).toBe(201);
    expect(passed.body.passed).toBe(true);
    const started = await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.run.preTrip).toMatchObject({ passed: true });
    // The odometer moved to the van's record.
    expect((await prisma.van.findUniqueOrThrow({ where: { id: f.van.id } })).odometerMiles).toBe(48_212);
    // Incomplete answers are refused.
    const run2 = await prisma.rideRun.create({ data: { vanId: f.van.id, driverUserId: f.driver.id, direction: 'FROM_WORK', serviceDate: f.serviceDate, departAt: new Date(f.targetAt.getTime() + 8 * 3_600_000), createdById: f.director.id } });
    const partial = await f.driverAgent.post(`/transport/driver/runs/${run2.id}/pre-trip`).send({ items: allOk().slice(2) });
    expect(partial.status).toBe(400);
    expect(partial.body.error.code).toBe('incomplete_check');
  });

  it('a fleet that switched the check off starts the run as before; a van out of service never leaves', async () => {
    const f = await fleet();
    await prisma.transportSettings.upsert({ where: { tenantId: '00000000-0000-4000-8000-000000000001' }, create: { preTripRequired: false }, update: { preTripRequired: false } });
    await prisma.van.update({ where: { id: f.van.id }, data: { outOfServiceAt: new Date(), outOfServiceReason: 'brakes' } });
    const parked = await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/start`);
    expect(parked.status).toBe(409);
    expect(parked.body.error.code).toBe('van_out_of_service');
    await prisma.van.update({ where: { id: f.van.id }, data: { outOfServiceAt: null, outOfServiceReason: null } });
    expect((await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/start`)).status).toBe(200);
  });
});

describe('the safety toolkit', () => {
  it('the SOS reaches the desk with the position; the desk acknowledges and the driver hears it', async () => {
    const f = await fleet();
    await prisma.rideRun.update({ where: { id: f.run.id }, data: { status: 'ACTIVE', startedAt: new Date(), lastLat: SEASIDE.lat, lastLng: SEASIDE.lng, lastLocationAt: new Date() } });
    const sos = await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/sos`).send({ note: 'flat tire on 98' });
    expect(sos.status).toBe(201);
    await flushPendingNotifications();
    const told = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: f.director.id, subject: { startsWith: 'SOS' } } });
    expect(told.subject).toContain('Mike Chen');
    expect(told.body).toContain('flat tire on 98');
    expect(told.body).toContain(SEASIDE.lat.toFixed(5));
    const live = await f.directorAgent.get('/transport/live');
    expect(live.body.runs[0].safety.sosAt).not.toBeNull();
    expect(live.body.runs[0].safety.sosAckAt).toBeNull();
    const needs = await f.directorAgent.get('/transport/needs-you');
    expect(needs.body.items.find((i: { key: string }) => i.key === 'sos').count).toBe(1);
    const inbox = await f.directorAgent.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'transport').count).toBeGreaterThanOrEqual(1);

    const ack = await f.directorAgent.post(`/transport/runs/${f.run.id}/sos/ack`);
    expect(ack.status).toBe(200);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { channel: 'IN_APP', recipientUserId: f.driver.id, subject: 'Transportation has your SOS' } })).toBe(1);
    expect((await f.directorAgent.get('/transport/needs-you')).body.items.find((i: { key: string }) => i.key === 'sos')).toBeUndefined();
  });

  it('"I\'m OK" clears a prompt; a shared link shows the van and no rider, and dies with the run', async () => {
    const f = await fleet();
    await prisma.rideRun.update({ where: { id: f.run.id }, data: { status: 'ACTIVE', startedAt: new Date(), stallAlertedAt: new Date(), lastLat: SEASIDE.lat, lastLng: SEASIDE.lng, lastLocationAt: new Date() } });
    expect((await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/ok`)).status).toBe(200);
    const run = await prisma.rideRun.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(run.stallAlertedAt).toBeNull();
    expect(run.driverOkAt).not.toBeNull();

    const share = await f.driverAgent.get(`/transport/driver/runs/${f.run.id}/share`);
    expect(share.status).toBe(200);
    expect(share.body.url).toContain('/track/');
    const anon = request(app());
    const track = await anon.get(`/transport/track/${share.body.token}`);
    expect(track.status).toBe(200);
    expect(track.body.trip.van.name).toBe('Van 1');
    expect(track.body.trip.driver).toBe('Mike');
    expect(track.body.trip.position).toMatchObject({ lat: SEASIDE.lat, lng: SEASIDE.lng });
    expect(JSON.stringify(track.body)).not.toContain('Ana');
    expect(JSON.stringify(track.body)).not.toContain('Gulf Blvd');
    expect((await anon.get('/transport/track/not-a-token')).status).toBe(404);
    // A real link past its six hours is gone (410), not "not valid" (F500 G5).
    const old = shareToken(f.run.id, new Date(Date.now() - 7 * 3_600_000));
    expect((await anon.get(`/transport/track/${old.token}`)).status).toBe(410);
    // A closed run keeps the page honest: the link no longer shares it.
    await prisma.rideRun.update({ where: { id: f.run.id }, data: { status: 'CANCELLED' } });
    expect((await anon.get(`/transport/track/${share.body.token}`)).status).toBe(410);
  });
});

describe('incidents', () => {
  it('an injury writes an OSHA incident per person, a collision parks the van, and the desk is told', async () => {
    const f = await fleet();
    const r = await f.driverAgent.post('/transport/incidents').send({
      kind: 'COLLISION',
      runId: f.run.id,
      description: 'Rear-ended at the light on Front Beach Rd; Ana hit her head on the seat in front.',
      injuries: true,
      injuredAssociateIds: [f.ana.id],
      parties: [{ name: 'J. Doe', plate: 'FL 1234', insurer: 'Geico' }],
      policeReportNumber: 'PCB-2026-0042',
    });
    expect(r.status).toBe(201);
    expect(r.body.incident.vanParked).toBe(true);
    expect(r.body.incident.oshaIncidentIds).toHaveLength(1);
    const osha = await prisma.oshaIncident.findUniqueOrThrow({ where: { id: r.body.incident.oshaIncidentIds[0] } });
    expect(osha.associateId).toBe(f.ana.id);
    expect(osha.clientId).toBe(f.client.id);
    expect(osha.description).toContain('Transport incident');
    const van = await prisma.van.findUniqueOrThrow({ where: { id: f.van.id } });
    expect(van.outOfServiceAt).not.toBeNull();
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { channel: 'IN_APP', recipientUserId: f.director.id, subject: { startsWith: 'Injury reported' } } })).toBe(1);
    // The parked van is refused for a new dispatch, and absent from the board's vans.
    const board = await f.directorAgent.get('/transport/board');
    expect(board.body.vans.find((v: { id: string }) => v.id === f.van.id)).toBeUndefined();
    // Review it; it leaves the desk's count.
    expect((await f.directorAgent.get('/transport/needs-you')).body.items.find((i: { key: string }) => i.key === 'incidents').count).toBe(1);
    const reviewed = await f.directorAgent.patch(`/transport/incidents/${r.body.incident.id}`).send({ status: 'REVIEWED', reviewNote: 'Insurer notified.' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.incident.status).toBe('REVIEWED');
    expect((await f.directorAgent.get('/transport/needs-you')).body.items.find((i: { key: string }) => i.key === 'incidents')).toBeUndefined();
    // Back in service through the fleet record.
    const back = await f.directorAgent.patch(`/transport/vans/${f.van.id}/record`).send({ outOfService: null, vin: '1ftbw3xm5pka12345', registrationExpiresAt: '2027-03-01' });
    expect(back.status).toBe(200);
    expect(back.body.record.outOfService).toBeNull();
    expect(back.body.record.vin).toBe('1FTBW3XM5PKA12345');
  });

  it('a rider cannot file one; a driver files only on their own run', async () => {
    const f = await fleet();
    expect((await f.anaAgent.post('/transport/incidents').send({ kind: 'OTHER', description: 'a long enough description' })).status).toBe(403);
    const other = await createUser({ role: 'DRIVER' });
    const agent = await loginAs(other.user.email);
    expect((await agent.post('/transport/incidents').send({ kind: 'OTHER', runId: f.run.id, description: 'a long enough description' })).status).toBe(404);
  });
});

describe('the rider\'s thumb and the drop-off word', () => {
  it('finishing the run tells each rider (once), and a finished ride can be rated; the director reads the trend', async () => {
    const f = await fleet();
    await prisma.transportSettings.upsert({ where: { tenantId: '00000000-0000-4000-8000-000000000001' }, create: { preTripRequired: false }, update: { preTripRequired: false } });
    await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/start`);
    await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/arrived`).send({ rideIds: [f.ride.id] });
    expect((await f.driverAgent.post(`/transport/driver/rides/${f.ride.id}/board`)).status).toBe(200);
    expect((await f.anaAgent.post(`/transport/me/rides/${f.ride.id}/feedback`).send({ thumbsUp: true })).status).toBe(409);
    expect((await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/complete`)).status).toBe(200);
    await flushPendingNotifications();
    const anaUser = await prisma.user.findFirstOrThrow({ where: { associateId: f.ana.id } });
    expect(await prisma.notification.count({ where: { channel: 'IN_APP', recipientUserId: anaUser.id, subject: { startsWith: "You're at" } } })).toBe(1);

    const pending = await f.anaAgent.get('/transport/me/feedback/pending');
    expect(pending.body.rides).toHaveLength(1);
    expect(pending.body.rides[0]).toMatchObject({ rideId: f.ride.id, van: 'Van 1', driver: 'Mike' });
    const fb = await f.anaAgent.post(`/transport/me/rides/${f.ride.id}/feedback`).send({ thumbsUp: false, reason: 'LATE', note: '15 minutes after the time' });
    expect(fb.status).toBe(201);
    expect((await f.anaAgent.get('/transport/me/feedback/pending')).body.rides).toHaveLength(0);
    const trend = await f.directorAgent.get(`/transport/feedback?from=${f.serviceDate}&to=${f.serviceDate}`);
    expect(trend.status).toBe(200);
    expect(trend.body.total).toMatchObject({ up: 0, down: 1, score: 0 });
    expect(trend.body.byDriver[0]).toMatchObject({ name: 'Mike Chen', down: 1, reasons: { LATE: 1 } });
    expect(trend.body.byRoute[0]).toMatchObject({ direction: 'TO_WORK', down: 1 });
    expect(trend.body.notes[0].note).toBe('15 minutes after the time');
    // Someone else's ride is not theirs to rate.
    const other = await createAssociate({ firstName: 'Bo', lastName: 'Rider' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: other.id });
    expect((await (await loginAs(user.email)).post(`/transport/me/rides/${f.ride.id}/feedback`).send({ thumbsUp: true })).status).toBe(404);
  });
});

describe('standing bookings', () => {
  async function signed(agent: TestAgent<Test>) {
    const me = await agent.get('/transport/me');
    const version = me.body.authorization?.agreement?.version;
    const r = await agent.post('/transport/me/authorization').send({ typedName: 'Ana Rider', ...(version ? { version } : {}) });
    if (r.status >= 300) throw new Error(`sign failed: ${r.status} ${JSON.stringify(r.body)}`);
  }

  it('books itself forward a week on the chosen days, skips what is already booked, and stops when cancelled', async () => {
    const f = await fleet();
    await signed(f.anaAgent);
    const stop = await prisma.transportStop.create({ data: { name: 'Seaside Housing', address: '100 Gulf Blvd', ...SEASIDE } });
    const today = dateKeyInZone(new Date(), f.store.timezone);
    const r = await f.anaAgent.post('/transport/me/series').send({
      direction: 'TO_WORK',
      locationId: f.store.id,
      stopId: stop.id,
      timeOfDay: '06:30',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startsOn: today,
    });
    expect(r.status).toBe(201);
    expect(r.body.series).toMatchObject({ active: true, timeOfDay: '06:30', pickup: { kind: 'stop', name: 'Seaside Housing' } });
    // A week ahead, less whatever is inside the cutoff today / tomorrow morning.
    const rides = await prisma.ride.findMany({ where: { seriesId: r.body.series.id }, orderBy: { targetAt: 'asc' } });
    expect(rides.length).toBeGreaterThanOrEqual(6);
    expect(rides.length).toBeLessThanOrEqual(8);
    expect(rides.every((x) => x.stopId === stop.id && x.status === 'REQUESTED' && x.fareCents === 500)).toBe(true);
    const tz = f.store.timezone;
    expect(rides.every((x) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(x.targetAt) === '06:30')).toBe(true);
    // Running the sweep again books nothing twice.
    const before = await prisma.ride.count({ where: { seriesId: r.body.series.id } });
    await generateAllSeries();
    expect(await prisma.ride.count({ where: { seriesId: r.body.series.id } })).toBe(before);
    // The rider sees it; cancelling stops the generator and keeps the rides.
    expect((await f.anaAgent.get('/transport/me/series')).body.series).toHaveLength(1);
    expect((await f.anaAgent.delete(`/transport/me/series/${r.body.series.id}`)).status).toBe(204);
    expect((await f.anaAgent.get('/transport/me/series')).body.series).toHaveLength(0);
    expect(await prisma.ride.count({ where: { seriesId: r.body.series.id } })).toBe(before);
  });

  it('needs a signed authorization and a store of theirs', async () => {
    const f = await fleet();
    const r = await f.anaAgent.post('/transport/me/series').send({ direction: 'TO_WORK', locationId: f.store.id, address: '100 Gulf Blvd', ...SEASIDE, timeOfDay: '06:30', daysOfWeek: [1], startsOn: '2026-01-01' });
    // No authorization yet: the series is kept but books nothing.
    expect(r.status).toBe(201);
    expect(r.body.booked).toBe(0);
    const other = await createClient('Elsewhere');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    const no = await f.anaAgent.post('/transport/me/series').send({ direction: 'TO_WORK', locationId: site.id, address: '100 Gulf Blvd', ...SEASIDE, timeOfDay: '06:30', daysOfWeek: [1], startsOn: '2026-01-01' });
    expect(no.status).toBe(403);
  });
});

describe('the fleet record, drivers and hours of service', () => {
  it('service log entries carry cost; an inspection sets the next due date; costs per client add up', async () => {
    const f = await fleet();
    const fuel = await f.directorAgent.post(`/transport/vans/${f.van.id}/service`).send({ kind: 'FUEL', occurredAt: f.serviceDate, costCents: 6_500, odometerMiles: 48_300 });
    expect(fuel.status).toBe(201);
    const insp = await f.directorAgent.post(`/transport/vans/${f.van.id}/service`).send({ kind: 'INSPECTION', occurredAt: f.serviceDate, costCents: 2_000, vendor: 'Beach Auto' });
    expect(insp.status).toBe(201);
    const record = await f.directorAgent.get(`/transport/vans/${f.van.id}/record`);
    expect(record.body.record.odometerMiles).toBe(48_300);
    expect(record.body.record.inspectionDueAt).toBe(new Date(Date.parse(`${f.serviceDate}T00:00:00Z`) + 365 * 86_400_000).toISOString().slice(0, 10));
    expect(record.body.serviceLog).toHaveLength(2);
    // A finished run with a boarded rider: fares in, driver hours and fuel out.
    const start = new Date(Date.now() - 2 * 3_600_000);
    await prisma.rideRun.update({ where: { id: f.run.id }, data: { status: 'COMPLETED', startedAt: start, endedAt: new Date(start.getTime() + 3_600_000) } });
    await prisma.ride.update({ where: { id: f.ride.id }, data: { status: 'COMPLETED', chargeCents: 500, completedAt: new Date() } });
    const costs = await f.directorAgent.get(`/transport/costs?from=${f.serviceDate}&to=${f.serviceDate}`);
    expect(costs.status).toBe(200);
    expect(costs.body.rows).toHaveLength(1);
    expect(costs.body.rows[0]).toMatchObject({ client: 'Coastal', seats: 1, faresCents: 500, fuelCents: 6_500, maintenanceCents: 2_000 });
    expect(costs.body.rows[0].driverCents).toBe(1_500); // one hour at the $15 default
    expect(costs.body.rows[0].costPerSeatCents).toBe(10_000);
    expect(costs.body.totals.netCents).toBe(500 - 10_000);
    expect((await f.directorAgent.delete(`/transport/vans/${f.van.id}/service/${fuel.body.entry.id}`)).status).toBe(204);
  });

  it('a lapsed licence refuses a dispatch; the desk sees it in the driver list, the expirations feed and the person\'s qualifications', async () => {
    const f = await fleet();
    const set = await f.directorAgent.patch(`/transport/drivers/${f.driver.id}/profile`).send({ licenceExpiresAt: '2020-01-01', licenceState: 'fl', licenceClass: 'E' });
    expect(set.status).toBe(200);
    expect(set.body.credentials.ok).toBe(false);
    expect(set.body.profile.licenceState).toBe('FL');
    const drivers = await f.directorAgent.get('/transport/drivers');
    expect(drivers.body.drivers.find((d: { userId: string }) => d.userId === f.driver.id).credentials.problems[0]).toMatchObject({ key: 'licence', expired: true });
    expect((await f.directorAgent.get('/transport/expiring?days=60')).body.items.find((i: { kind: string }) => i.kind === 'driver')).toMatchObject({ name: 'Mike Chen', document: "Driver's licence" });
    const qual = await prisma.associateQualification.findFirst({ where: { associateId: f.mike.id, deletedAt: null }, include: { qualification: true } });
    expect(qual?.qualification.code).toBe('DRIVER_LICENCE');
    expect(qual?.expiresAt?.toISOString().slice(0, 10)).toBe('2020-01-01');

    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Rider' });
    const ride = await prisma.ride.create({ data: { associateId: bo.id, direction: 'TO_WORK', locationId: f.store.id, address: 'x', ...SEASIDE, targetAt: f.targetAt, serviceDate: f.serviceDate, fareCents: 500, noShowFeeCents: 100, createdById: f.director.id } });
    const dispatch = await f.directorAgent.post('/transport/runs').send({
      vanId: f.van.id,
      driverUserId: f.driver.id,
      direction: 'TO_WORK',
      serviceDate: f.serviceDate,
      departAt: new Date(f.targetAt.getTime() - 45 * 60_000).toISOString(),
      rides: [{ rideId: ride.id, pickupAt: new Date(f.targetAt.getTime() - 30 * 60_000).toISOString() }],
    });
    expect(dispatch.status).toBe(409);
    expect(dispatch.body.error.code).toBe('driver_credentials');
    // The plan never offers them a new van; Bo tops up the fixture's run
    // (transport walk 3), which keeps its driver — and the proposal says
    // that driver can't drive it now.
    const plan = await f.directorAgent.post('/transport/plan').send({ date: f.serviceDate });
    for (const p of plan.body.proposals.filter((x: { kind: string }) => x.kind === 'new')) expect(p.driverUserId).not.toBe(f.driver.id);
    const topUp = plan.body.proposals.find((x: { kind: string }) => x.kind === 'topUp');
    expect(topUp).toMatchObject({ runId: f.run.id });
    expect(topUp.warnings.join(' ')).toMatch(/can't drive it now/);
    // Current again: the dispatch goes through — once the fixture's run on
    // the same van at the same time is called off (one run at a time per
    // van and driver, transport walk 1).
    await f.directorAgent.patch(`/transport/drivers/${f.driver.id}/profile`).send({ licenceExpiresAt: '2030-01-01' });
    await prisma.rideRun.update({ where: { id: f.run.id }, data: { status: 'CANCELLED' } });
    const ok = await f.directorAgent.post('/transport/runs').send({
      vanId: f.van.id,
      driverUserId: f.driver.id,
      direction: 'TO_WORK',
      serviceDate: f.serviceDate,
      departAt: new Date(f.targetAt.getTime() - 45 * 60_000).toISOString(),
      rides: [{ rideId: ride.id, pickupAt: new Date(f.targetAt.getTime() - 30 * 60_000).toISOString() }],
    });
    expect(ok.status).toBe(201);
    // The driver's own view: the licence lapses in the profile they read.
    const mine = await f.driverAgent.get('/transport/driver/profile');
    expect(mine.body.profile.licenceExpiresAt).toBe('2030-01-01');
    expect((await f.driverAgent.patch('/transport/driver/profile').send({ navApp: 'WAZE' })).body.profile.navApp).toBe('WAZE');
  });

  it('driver shifts: a day that schedules drivers takes only drivers on shift; hours of service bound the shift and the day', async () => {
    const f = await fleet();
    // Fixed times on tomorrow's store-local day: the run at 10:00, a driver
    // shift that evening — never straddling midnight, whatever time it is now.
    const [y, mo, d] = dateKeyInZone(new Date(Date.now() + 86_400_000), f.store.timezone).split('-').map(Number) as [number, number, number];
    const at = (h: number) => zonedWallTimeToUtcInstant(y, mo, d, h * 60, f.store.timezone);
    const targetAt = at(10);
    const serviceDate = dateKeyInZone(targetAt, f.store.timezone);
    const dayStart = at(5);
    // Too long for the day.
    const long = await f.directorAgent.post('/transport/driver-shifts').send({ driverUserId: f.driver.id, startsAt: dayStart.toISOString(), endsAt: new Date(dayStart.getTime() + 12 * 3_600_000).toISOString() });
    expect(long.status).toBe(409);
    expect(long.body.error.code).toBe('hours_of_service');
    // A driver with no person record can't be scheduled.
    const ghost = await createUser({ role: 'DRIVER' });
    expect((await f.directorAgent.post('/transport/driver-shifts').send({ driverUserId: ghost.user.id, startsAt: dayStart.toISOString(), endsAt: new Date(dayStart.getTime() + 8 * 3_600_000).toISOString() })).body.error.code).toBe('driver_not_on_file');
    // An evening shift, so the morning run finds nobody on shift.
    const evening = at(16);
    const shift = await f.directorAgent.post('/transport/driver-shifts').send({ driverUserId: f.driver.id, startsAt: evening.toISOString(), endsAt: new Date(evening.getTime() + 4 * 3_600_000).toISOString() });
    expect(shift.status).toBe(201);
    expect(shift.body.shift.driver.name).toBe('Mike Chen');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.body.shift.id } })).position).toBe(DRIVER_POSITION);
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Rider' });
    const ride = await prisma.ride.create({ data: { associateId: bo.id, direction: 'TO_WORK', locationId: f.store.id, address: 'x', ...SEASIDE, targetAt, serviceDate, fareCents: 500, noShowFeeCents: 100, createdById: f.director.id } });
    const departAt = new Date(targetAt.getTime() - 45 * 60_000).toISOString();
    const body = { vanId: f.van.id, driverUserId: f.driver.id, direction: 'TO_WORK', serviceDate, departAt, rides: [{ rideId: ride.id, pickupAt: new Date(targetAt.getTime() - 30 * 60_000).toISOString() }] };
    const off = await f.directorAgent.post('/transport/runs').send(body);
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('driver_not_on_shift');
    // Rest between shifts: one butting up against the evening one is refused.
    const close = await f.directorAgent.post('/transport/driver-shifts').send({ driverUserId: f.driver.id, startsAt: new Date(evening.getTime() + 5 * 3_600_000).toISOString(), endsAt: new Date(evening.getTime() + 7 * 3_600_000).toISOString() });
    expect(close.body.error.code).toBe('hours_of_service');
    // Remove the evening shift: the day no longer schedules drivers, the dispatch is free again.
    expect((await f.directorAgent.delete(`/transport/driver-shifts/${shift.body.shift.id}`)).status).toBe(204);
    expect((await f.directorAgent.post('/transport/runs').send(body)).status).toBe(201);
    // The driver's day: runs, hours (none clocked), the shift list, the pay estimate.
    // "Today" is the company's day (Eastern), so give the driver a run on it: the
    // fixture's run is 90 minutes out, which after 10:30 PM Eastern is tomorrow.
    const todayKey = dateKeyInZone(new Date(), DEFAULT_TIMEZONE);
    if (f.serviceDate !== todayKey) {
      await prisma.rideRun.create({ data: { vanId: f.van.id, driverUserId: f.driver.id, direction: 'FROM_WORK', serviceDate: todayKey, departAt: new Date(), createdById: f.director.id } });
    }
    const today = await f.driverAgent.get('/transport/driver/today');
    expect(today.status).toBe(200);
    expect(today.body.associateId).toBe(f.mike.id);
    expect(today.body.runs.total).toBeGreaterThanOrEqual(1);
    expect(today.body.earnings.hourlyRate).toBe(15);
    expect(today.body.hoursOfService).toEqual({ maxPerDay: 10, minRest: 8 });
    // The driver's own clock: in, refused twice, out — and the punch is theirs.
    const cin = await f.driverAgent.post('/transport/driver/clock-in');
    expect(cin.status).toBe(201);
    expect((await f.driverAgent.post('/transport/driver/clock-in')).body.error.code).toBe('already_clocked_in');
    expect((await f.driverAgent.get('/transport/driver/today')).body.hours.onClock).toBe(true);
    const cout = await f.driverAgent.post('/transport/driver/clock-out');
    expect(cout.status).toBe(200);
    const time = await f.driverAgent.get('/transport/driver/time');
    expect(time.body.entries[0]).toMatchObject({ status: 'COMPLETED' });
    expect(await prisma.timeEntry.count({ where: { associateId: f.mike.id } })).toBe(1);
    // A driver with no person record is told why.
    const ghostAgent = await loginAs(ghost.user.email);
    expect((await ghostAgent.post('/transport/driver/clock-in')).body.error.code).toBe('no_associate_record');
  });
});

describe('the road network, when it answers', () => {
  it('orders the pickups the way the optimizer says and times them by its legs', async () => {
    const f = await fleet();
    const near = { lat: 30.19, lng: -85.82 };
    const far = { lat: 30.25, lng: -85.9 };
    const mid = { lat: 30.22, lng: -85.86 };
    const mk = async (name: string, at: { lat: number; lng: number }) => {
      const a = await createAssociate({ firstName: name, lastName: 'Rider' });
      return prisma.ride.create({ data: { associateId: a.id, direction: 'TO_WORK', locationId: f.store.id, address: name, ...at, targetAt: f.targetAt, serviceDate: f.serviceDate, fareCents: 500, noShowFeeCents: 100, createdById: f.director.id } });
    };
    const [n, fa, m] = await Promise.all([mk('Near', near), mk('Far', far), mk('Mid', mid)]);
    let optimizerCalls = 0;
    setRoutingForTests(
      async (points) => ({ seconds: points.slice(1).map(() => 600), metres: points.slice(1).map(() => 5000) }),
      async (points, opts) => {
        optimizerCalls += 1;
        expect(opts).toEqual({ fixStart: true, fixEnd: true });
        // The optimizer's answer: far, then NEAR before MID (not what nearest-next would say), then the store.
        const idx = (p: { lat: number; lng: number }) => points.findIndex((x) => Math.abs(x.lat - p.lat) < 1e-6 && Math.abs(x.lng - p.lng) < 1e-6);
        return [idx(far), idx(near), idx(mid), points.length - 1];
      },
    );
    const r = await f.directorAgent.post('/transport/route').send({ rideIds: [n.id, fa.id, m.id] });
    expect(r.status).toBe(200);
    expect(optimizerCalls).toBe(1);
    expect(r.body.rides.map((x: { rideId: string }) => x.rideId)).toEqual([fa.id, n.id, m.id]);
    // Ten minutes a leg, a minute's dwell: 11 minutes apart, 15 minutes (10 + 5 buffer) before the arrive-by at the last.
    const times = r.body.rides.map((x: { pickupAt: string }) => Date.parse(x.pickupAt));
    expect(times[2] - times[1]).toBe(11 * 60_000);
    expect(times[1] - times[0]).toBe(11 * 60_000);
    expect(f.targetAt.getTime() - times[2]).toBe(16 * 60_000);
  });
});
