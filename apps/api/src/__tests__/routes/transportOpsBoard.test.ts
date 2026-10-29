import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { TransportException, TransportKpi, TransportOpsBoard, TransportReadiness } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { setGeocoderForTests } from '../../lib/geocode.js';
import { setRoutingForTests } from '../../lib/mapboxRouting.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import { zonedWallTimeToUtcInstant } from '../../lib/timezone.js';
import { conflictPairs, runConflicts } from '../../lib/transportConflicts.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The dispatcher's live operations and tomorrow's readiness (transport
 * upgrade 2026-10-28): GET /transport/ops — every van, the exceptions worst
 * first with the numbers right, the four KPIs from seeded rides — and GET
 * /transport/readiness, each check flipping as the day is fixed. Runs carry
 * the board's double-booking rule (conflicts) on the board and on the
 * driver's own list. A driver can't read the desk's board; another
 * tenant's vans never show.
 */

const ALTO = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-0000000000b7';
const M = 60_000;
const STORE = { lat: 30.1766, lng: -85.8055 };
const SEASIDE = { lat: 30.2106, lng: -85.865 };

beforeEach(async () => {
  await truncateAll();
  await prisma.transportSettings.upsert({ where: { tenantId: ALTO }, create: { preTripRequired: false }, update: { preTripRequired: false } });
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

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A small fleet at a fixed clock: Wednesday noon in the stores' zone. */
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
  const van1 = await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 12 } });
  const van2 = await prisma.van.create({ data: { name: 'Van 2', plate: 'ALT 102', capacity: 12 } });
  const van3 = await prisma.van.create({ data: { name: 'Van 3', plate: 'ALT 103', capacity: 8 } });

  async function rider(firstName: string, o: { direction?: 'TO_WORK' | 'FROM_WORK'; targetAt?: Date; serviceDate?: string; status?: 'REQUESTED' | 'SCHEDULED' | 'BOARDED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED'; runId?: string; pickupAt?: Date; vanArrivedAt?: Date; pickupOrder?: number } = {}) {
    const a = await createAssociate({ firstName, lastName: 'Rider' });
    const targetAt = o.targetAt ?? at(120);
    return prisma.ride.create({
      data: {
        associateId: a.id,
        direction: o.direction ?? 'TO_WORK',
        locationId: store.id,
        address: '9 Harbor Rd',
        ...SEASIDE,
        targetAt,
        serviceDate: o.serviceDate ?? dateKeyInZone(targetAt, store.timezone),
        status: o.status ?? 'REQUESTED',
        runId: o.runId ?? null,
        pickupOrder: o.pickupOrder ?? null,
        pickupAt: o.pickupAt ?? null,
        vanArrivedAt: o.vanArrivedAt ?? null,
        fareCents: 500,
        noShowFeeCents: 100,
        chargeCents: o.status === 'COMPLETED' ? 500 : o.status === 'NO_SHOW' ? 100 : 0,
        noShowAt: o.status === 'NO_SHOW' ? (o.pickupAt ?? targetAt) : null,
        createdById: director.id,
      },
    });
  }
  async function run(o: { vanId: string; driverUserId: string; departAt: Date; direction?: 'TO_WORK' | 'FROM_WORK'; status?: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED'; serviceDate?: string; startedAt?: Date; endedAt?: Date }) {
    return prisma.rideRun.create({
      data: {
        vanId: o.vanId,
        driverUserId: o.driverUserId,
        direction: o.direction ?? 'TO_WORK',
        serviceDate: o.serviceDate ?? dateKeyInZone(o.departAt, store.timezone),
        departAt: o.departAt,
        status: o.status ?? 'PLANNED',
        startedAt: o.startedAt ?? (o.status === 'ACTIVE' || o.status === 'COMPLETED' ? o.departAt : null),
        endedAt: o.endedAt ?? null,
        createdById: director.id,
      },
    });
  }
  return { now, at, client, store, today, director, mike, mikeA, lee, van1, van2, van3, rider, run, desk: await loginAs(director.email) };
}

const exceptionsOf = (b: TransportOpsBoard, kind: TransportException['kind']) => b.exceptions.filter((e) => e.kind === kind);
const kpi = (b: TransportOpsBoard, id: TransportKpi['id']) => b.kpis.find((k) => k.id === id)!;

describe('GET /transport/ops — the vans', () => {
  it('names every van’s state: on the road, without signal, planned, idle, out of service — with the live position and the last-seen one', async () => {
    const f = await fleet();
    // Van 1 on the road, pinging; Van 2 idle but seen at the end of yesterday's run; Van 3 parked.
    const live = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(-20), status: 'ACTIVE' });
    await prisma.rideRun.update({ where: { id: live.id }, data: { lastLat: SEASIDE.lat, lastLng: SEASIDE.lng, lastHeading: 90, lastLocationAt: f.at(-1) } });
    await f.rider('Ana', { status: 'SCHEDULED', runId: live.id, pickupAt: f.at(5), pickupOrder: 1 });
    await f.rider('Bo', { status: 'BOARDED', runId: live.id, pickupAt: f.at(-10), pickupOrder: 2 });
    const yesterday = await f.run({ vanId: f.van2.id, driverUserId: f.lee.id, departAt: f.at(-24 * 60), status: 'COMPLETED', endedAt: f.at(-23 * 60) });
    await prisma.rideRun.update({ where: { id: yesterday.id }, data: { lastLat: 30.2, lastLng: -85.8, lastLocationAt: f.at(-23 * 60) } });
    await prisma.van.update({ where: { id: f.van3.id }, data: { outOfServiceAt: f.at(-60), outOfServiceReason: 'Brake light out' } });

    const r = await f.desk.get('/transport/ops');
    expect(r.status).toBe(200);
    const b = r.body as TransportOpsBoard;
    expect(b).toMatchObject({ date: f.today, timezone: 'America/New_York', center: STORE });
    const byName = new Map(b.vans.map((v) => [v.name, v]));
    expect(byName.get('Van 1')).toMatchObject({
      state: 'on_road',
      position: { lat: SEASIDE.lat, lng: SEASIDE.lng, heading: 90 },
      positionAgeMinutes: 1,
      run: { runId: live.id, driverName: 'Mike Chen', driverPhone: '(850) 555-0101', onBoard: 1, toPickUp: 1, lateMinutes: 0 },
      nextRun: null,
    });
    expect(byName.get('Van 1')!.run!.nextStop).toMatchObject({ label: 'Ana Rider', scheduledAt: f.at(5).toISOString() });
    expect(byName.get('Van 2')).toMatchObject({ state: 'idle', run: null, positionAgeMinutes: 23 * 60, position: { lat: 30.2, lng: -85.8 } });
    expect(byName.get('Van 3')).toMatchObject({ state: 'out_of_service', position: null });

    // The phone goes quiet: still on the road, no signal.
    await prisma.rideRun.update({ where: { id: live.id }, data: { lastLocationAt: f.at(-5) } });
    // Van 2 gets a run later today: planned, with its next run.
    const later = await f.run({ vanId: f.van2.id, driverUserId: f.lee.id, departAt: f.at(180) });
    await f.rider('Cy', { status: 'SCHEDULED', runId: later.id, pickupAt: f.at(190), targetAt: f.at(240) });
    const b2 = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    const v1 = b2.vans.find((v) => v.name === 'Van 1')!;
    const v2 = b2.vans.find((v) => v.name === 'Van 2')!;
    expect(v1.state).toBe('no_signal');
    expect(v2).toMatchObject({ state: 'planned', nextRun: { runId: later.id, driverName: 'Lee Park', riders: 1, departAt: f.at(180).toISOString() } });
  });
});

describe('GET /transport/ops — the exceptions', () => {
  it('a van behind at its next stop is late by the right minutes (medium from 5, high from 15), with a call to the driver', async () => {
    const f = await fleet();
    const live = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(-30), status: 'ACTIVE' });
    // The van is at the pickup now; the pickup was due 9 minutes ago.
    await prisma.rideRun.update({ where: { id: live.id }, data: { lastLat: SEASIDE.lat, lastLng: SEASIDE.lng, lastLocationAt: f.at(0) } });
    const ana = await f.rider('Ana', { status: 'SCHEDULED', runId: live.id, pickupAt: f.at(-9), pickupOrder: 1, targetAt: f.at(60) });
    const b = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    const [late] = exceptionsOf(b, 'late');
    expect(late).toMatchObject({
      id: `late:${live.id}`,
      severity: 'medium',
      title: 'Van 1 is 9 minutes late at Ana Rider',
      runId: live.id,
      vanId: f.van1.id,
      driverUserId: f.mike.id,
      action: { kind: 'call_driver', label: 'Call Mike', target: 'tel:8505550101' },
    });
    expect(b.vans.find((v) => v.name === 'Van 1')!.run!.lateMinutes).toBe(9);

    await prisma.ride.update({ where: { id: ana.id }, data: { pickupAt: f.at(-16) } });
    const b2 = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(exceptionsOf(b2, 'late')[0]).toMatchObject({ id: `late:${live.id}`, severity: 'high', title: 'Van 1 is 16 minutes late at Ana Rider' });
  });

  it('one driver on two overlapping runs is driver_double_booked — and both runs carry the conflict on the board and on the driver’s list', async () => {
    const f = await fleet();
    const a = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(60) });
    const b = await f.run({ vanId: f.van2.id, driverUserId: f.mike.id, departAt: f.at(90) });
    // Lee's run on Van 3 overlaps nobody's.
    await f.run({ vanId: f.van3.id, driverUserId: f.lee.id, departAt: f.at(60) });
    const ops = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    const [dbl] = exceptionsOf(ops, 'driver_double_booked');
    // Busy windows: 45→180 and 75→210 minutes from now — 105 minutes shared.
    expect(dbl).toMatchObject({ id: `driver_double_booked:${a.id}:${b.id}`, severity: 'high', runId: b.id, driverUserId: f.mike.id, action: { kind: 'open_run', target: b.id } });
    expect(dbl!.title).toMatch(/^Mike Chen is on two runs at once — \d+:\d\d (AM|PM) and \d+:\d\d (AM|PM)$/);
    expect(dbl!.detail).toBe("Van 1's and Van 2's runs overlap by 105 minutes. Give one of them another driver.");
    expect(exceptionsOf(ops, 'van_double_booked')).toEqual([]);

    const board = (await f.desk.get(`/transport/board?date=${f.today}`)).body as { runs: Array<{ id: string; conflicts: unknown[]; notRun: boolean }> };
    expect(board.runs.find((r) => r.id === a.id)).toMatchObject({ notRun: false, conflicts: [{ kind: 'driver', runId: b.id, overlapMinutes: 105 }] });
    expect(board.runs.find((r) => r.id === b.id)!.conflicts).toEqual([{ kind: 'driver', runId: a.id, overlapMinutes: 105 }]);
    expect(board.runs.filter((r) => r.id !== a.id && r.id !== b.id).every((r) => r.conflicts.length === 0)).toBe(true);

    const driverList = (await (await loginAs(f.mike.email)).get('/transport/driver/runs')).body as { runs: Array<{ id: string; conflicts: unknown[]; notRun: boolean; preTripDone: boolean }> };
    expect(driverList.runs.find((r) => r.id === a.id)).toMatchObject({ notRun: false, preTripDone: false, conflicts: [{ kind: 'driver', runId: b.id, overlapMinutes: 105 }] });

    // The same van twice is a van double-booking too (and the rule is the Gantt's: cancelled runs don't count).
    const c = await f.run({ vanId: f.van3.id, driverUserId: f.mike.id, departAt: f.at(400) });
    const d = await f.run({ vanId: f.van3.id, driverUserId: f.lee.id, departAt: f.at(420) });
    const ops2 = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(exceptionsOf(ops2, 'van_double_booked').map((e) => e.id)).toEqual([`van_double_booked:${c.id}:${d.id}`]);
    await prisma.rideRun.update({ where: { id: d.id }, data: { status: 'CANCELLED' } });
    const ops3 = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(exceptionsOf(ops3, 'van_double_booked')).toEqual([]);
  });

  it('riders booked today with no van are one needs_van item per way, place and half hour, carrying the ride ids to assign', async () => {
    const f = await fleet();
    const a = await f.rider('Ana', { targetAt: f.at(120) });
    const b = await f.rider('Bo', { targetAt: f.at(125) });
    const c = await f.rider('Cy', { direction: 'FROM_WORK', targetAt: f.at(300) });
    const ops = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    const items = exceptionsOf(ops, 'needs_van');
    expect(items).toHaveLength(2);
    const toWork = items.find((e) => e.rideIds!.includes(a.id))!;
    expect(toWork).toMatchObject({ severity: 'medium', action: { kind: 'assign_van', label: 'Assign a van' } });
    expect(toWork.rideIds!.sort()).toEqual([a.id, b.id].sort());
    expect(toWork.title).toMatch(/^2 riders to Gulf Pines at \d+:\d\d PM have no van$/);
    expect(items.find((e) => e.rideIds!.includes(c.id))!.title).toMatch(/^1 rider home from Gulf Pines at \d+:\d\d PM has no van$/);
    // Stable ids: the same item next poll.
    const again = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(exceptionsOf(again, 'needs_van').map((e) => e.id).sort()).toEqual(items.map((e) => e.id).sort());
  });

  it('orders the queue worst first, then oldest: SOS and a run that never left before a no-show and a report', async () => {
    const f = await fleet();
    const sos = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(-30), status: 'ACTIVE' });
    await prisma.rideRun.update({ where: { id: sos.id }, data: { sosAt: f.at(-2), sosNote: 'Flat tire' } });
    const stale = await f.run({ vanId: f.van2.id, driverUserId: f.lee.id, departAt: f.at(-25) });
    await f.rider('Ana', { status: 'SCHEDULED', runId: stale.id, pickupAt: f.at(-15), targetAt: f.at(30) });
    const gone = await f.rider('Bo', { status: 'NO_SHOW', runId: sos.id, pickupAt: f.at(-20), targetAt: f.at(30) });
    await prisma.ride.update({ where: { id: gone.id }, data: { noShowAt: f.at(-20) } });
    const issue = await prisma.transportIssue.create({ data: { reportedById: f.director.id, category: 'LATE_VAN', body: 'The van came 20 minutes late. I missed the start.' } });
    const ops = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(ops.exceptions.map((e) => e.kind)).toEqual(['not_started', 'sos', 'no_show', 'open_issue']);
    expect(ops.exceptions[0]).toMatchObject({ id: `not_started:${stale.id}`, severity: 'high', runId: stale.id });
    expect(ops.exceptions[0]!.title).toMatch(/^Van 2 hasn't left — 25 minutes past \d+:\d\d (AM|PM)$/);
    expect(ops.exceptions[1]).toMatchObject({ id: `sos:${sos.id}`, title: 'SOS from Mike in Van 1', action: { kind: 'ack_sos', target: sos.id } });
    expect(ops.exceptions[1]!.detail).toContain('“Flat tire”');
    expect(ops.exceptions[2]).toMatchObject({ severity: 'low', title: 'Bo Rider was a no-show at 9 Harbor Rd', action: { kind: 'open_ride', target: gone.id } });
    expect(ops.exceptions[3]).toMatchObject({ id: `open_issue:${issue.id}`, severity: 'low', detail: 'The van came 20 minutes late.', action: { kind: 'open_issue', target: issue.id } });
  });

  it('a parked van with a run, a driver who can’t drive, and a failed walk-around each say so', async () => {
    const f = await fleet();
    await prisma.transportSettings.update({ where: { tenantId: ALTO }, data: { preTripRequired: true } });
    const parked = await f.run({ vanId: f.van3.id, driverUserId: f.lee.id, departAt: f.at(240) });
    await prisma.van.update({ where: { id: f.van3.id }, data: { outOfServiceAt: f.at(-90), outOfServiceReason: 'Brake light out' } });
    await prisma.driverProfile.create({ data: { userId: f.mike.id, licenceExpiresAt: new Date(`${addDays(f.today, -3)}T00:00:00Z`) } });
    const r1 = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(60) });
    await prisma.preTripCheck.create({ data: { runId: r1.id, vanId: f.van1.id, driverUserId: f.mike.id, passed: false, items: [{ key: 'brakes', ok: false }, { key: 'tires', ok: true }] } });
    const ops = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(exceptionsOf(ops, 'van_out_of_service')[0]).toMatchObject({ title: 'Van 3 is out of service with 1 run today', detail: 'Brake light out. Move the run to another van.', runId: parked.id });
    expect(exceptionsOf(ops, 'credential_lapsed')[0]).toMatchObject({ title: "Mike Chen can't drive — driver's licence lapsed", driverUserId: f.mike.id, action: { kind: 'open_setup', target: 'drivers' } });
    expect(exceptionsOf(ops, 'pre_trip_failed')[0]).toMatchObject({ title: 'Van 1 failed its pre-trip check', runId: r1.id });
    expect(exceptionsOf(ops, 'pre_trip_failed')[0]!.detail).toMatch(/^Brakes failed — 1 run today can't leave/);
    // Lee has no driver record while records are kept: he can't drive either.
    expect(exceptionsOf(ops, 'credential_lapsed').find((e) => e.driverUserId === f.lee.id)?.title).toBe("Lee Park can't drive — no licence on file");
  });
});

describe('GET /transport/ops — one clock, one day', () => {
  const clock = (d: Date, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);

  it('reads every time in the stores’ own zone, and says which zone the web should use', async () => {
    const f = await fleet();
    await prisma.site.update({ where: { id: f.store.id }, data: { timezone: 'America/Chicago' } });
    const stale = await f.run({ vanId: f.van2.id, driverUserId: f.lee.id, departAt: f.at(-25) });
    await f.rider('Ana', { status: 'SCHEDULED', runId: stale.id, pickupAt: f.at(-15), targetAt: f.at(30) });
    const ops = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(ops.timezone).toBe('America/Chicago');
    const item = exceptionsOf(ops, 'not_started')[0]!;
    // The chip the web draws from departAt in `timezone` and the sentence say the same time.
    expect(item.title).toBe(`Van 2 hasn't left — 25 minutes past ${clock(f.at(-25), 'America/Chicago')}`);
    expect(item.title).not.toContain(clock(f.at(-25), 'America/New_York'));
  });

  it('places in two zones: the company zone for the web, and each sentence names its zone', async () => {
    const f = await fleet();
    await prisma.site.update({ where: { id: f.store.id }, data: { timezone: 'America/Chicago' } });
    const other = await createClient('Harbor Inn');
    const east = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    const stale = await f.run({ vanId: f.van2.id, driverUserId: f.lee.id, departAt: f.at(-25) });
    await f.rider('Ana', { status: 'SCHEDULED', runId: stale.id, pickupAt: f.at(-15), targetAt: f.at(30) });
    const a = await createAssociate({ firstName: 'Eve', lastName: 'East' });
    await prisma.ride.create({ data: { associateId: a.id, direction: 'TO_WORK', locationId: east.id, address: '1 Main St', targetAt: f.at(120), serviceDate: f.today, fareCents: 500, noShowFeeCents: 100, createdById: f.director.id } });
    const ops = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(ops.timezone).toBe('America/New_York');
    expect(exceptionsOf(ops, 'not_started')[0]!.title).toMatch(new RegExp(`past ${clock(f.at(-25), 'America/Chicago')} C[DS]T$`));
    expect(exceptionsOf(ops, 'needs_van')[0]!.title).toMatch(/ E[DS]T has no van$/);
  });

  it('lists a run that didn’t run on its own day’s board only', async () => {
    const f = await fleet();
    const yesterday = addDays(f.today, -1);
    const old = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: f.at(-20 * 60), serviceDate: yesterday });
    const todays = await f.run({ vanId: f.van2.id, driverUserId: f.lee.id, departAt: f.at(-4 * 60) });
    await prisma.rideRun.updateMany({ where: { id: { in: [old.id, todays.id] } }, data: { status: 'CANCELLED', autoClosedAt: f.at(-5) } });
    const today = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(exceptionsOf(today, 'didnt_run').map((e) => e.runId)).toEqual([todays.id]);
    const before = (await f.desk.get(`/transport/ops?date=${yesterday}`)).body as TransportOpsBoard;
    expect(exceptionsOf(before, 'didnt_run').map((e) => e.runId)).toEqual([old.id]);
  });
});

describe('GET /transport/ops — the KPIs', () => {
  it('works the last 7 days against the 7 before, with eight complete weeks of trend', async () => {
    const f = await fleet();
    const day = (n: number) => addDays(f.today, n);
    const noon = (ymd: string) => new Date(`${ymd}T16:00:00Z`);
    // Yesterday: one run, an hour on the clock, 3 riders carried (2 on time, 1 ten minutes late), 1 no-show, $30 of fuel.
    const y = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: noon(day(-1)), serviceDate: day(-1), status: 'COMPLETED', endedAt: new Date(noon(day(-1)).getTime() + 60 * M) });
    const yp = noon(day(-1));
    for (const [name, late] of [['A', 2], ['B', 2], ['C', 10]] as const) {
      await f.rider(name, { status: 'COMPLETED', runId: y.id, serviceDate: day(-1), targetAt: yp, pickupAt: yp, vanArrivedAt: new Date(yp.getTime() + late * M) });
    }
    await f.rider('D', { status: 'NO_SHOW', runId: y.id, serviceDate: day(-1), targetAt: yp, pickupAt: yp, vanArrivedAt: yp });
    await prisma.vanServiceEntry.create({ data: { vanId: f.van1.id, kind: 'FUEL', occurredAt: new Date(`${day(-1)}T00:00:00Z`), costCents: 3000 } });
    // Eight days ago: one run, an hour, 4 riders all on time.
    const p = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: noon(day(-8)), serviceDate: day(-8), status: 'COMPLETED', endedAt: new Date(noon(day(-8)).getTime() + 60 * M) });
    for (const name of ['E', 'F', 'G', 'H']) {
      await f.rider(name, { status: 'COMPLETED', runId: p.id, serviceDate: day(-8), targetAt: noon(day(-8)), pickupAt: noon(day(-8)), vanArrivedAt: noon(day(-8)) });
    }
    const ops = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(ops.kpis.map((k) => k.id)).toEqual(['onTime', 'utilization', 'costPerRide', 'noShowRate']);
    expect(kpi(ops, 'onTime')).toMatchObject({ unit: 'pct', value: 66.7, compare: 100, delta: -33.3, betterWhen: 'up', status: 'bad' });
    expect(kpi(ops, 'utilization')).toMatchObject({ value: 25, compare: 33.3, status: 'bad' });
    expect(kpi(ops, 'noShowRate')).toMatchObject({ value: 25, compare: 0, status: 'bad', betterWhen: 'down' });
    // An hour at the default $15 plus $30 of fuel over 3 rides; the week before, an hour over 4.
    expect(kpi(ops, 'costPerRide')).toMatchObject({ unit: 'money', value: 15, compare: 3.75, betterWhen: 'down', status: 'bad' });
    expect(kpi(ops, 'costPerRide').statusLabel).toBe('Up 300% on the week before');
    for (const k of ops.kpis) {
      expect(k.trend).toHaveLength(8);
      expect(k.definition.length).toBeGreaterThan(20);
    }
    // Wednesday − 8 is last week's Tuesday: the newest complete week; yesterday is this (partial) week.
    expect(kpi(ops, 'onTime').trend).toEqual([null, null, null, null, null, null, null, 100]);
    expect(kpi(ops, 'utilization').trend[7]).toBe(33.3);
  });

  it('says nothing to judge on a fleet with no rides', async () => {
    const f = await fleet();
    const ops = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    for (const k of ops.kpis) expect(k).toMatchObject({ value: null, compare: null, delta: null, status: 'none' });
  });
});

describe('GET /transport/readiness', () => {
  it('defaults to tomorrow and is ready when tomorrow is empty', async () => {
    const f = await fleet();
    const r = await f.desk.get('/transport/readiness');
    expect(r.status).toBe(200);
    const body = r.body as TransportReadiness;
    expect(body).toMatchObject({ date: addDays(f.today, 1), ready: true, riders: 0, runs: 0 });
    expect(body.items.map((i) => i.id)).toEqual(['riders_placed', 'seats', 'drivers_assigned_ok', 'credentials', 'vans_ready', 'vans_double_booked']);
    expect(body.items.every((i) => i.ok && i.count === 0 && i.action === null)).toBe(true);
  });

  it('flips each check as the day goes wrong — and back as it is fixed', async () => {
    const f = await fleet();
    const tomorrow = addDays(f.today, 1);
    const wall = (ymd: string, h: number, m = 0) => {
      const [y, mo, d] = ymd.split('-').map(Number) as [number, number, number];
      return zonedWallTimeToUtcInstant(y, mo, d, h * 60 + m, 'America/New_York');
    };
    const t = (h: number, m = 0) => wall(tomorrow, h, m);
    await prisma.transportSettings.update({ where: { tenantId: ALTO }, data: { driverMaxHoursPerDay: 10, driverMinRestHours: 8 } });
    // A waiting rider; Van 3 (8 seats) carrying 9 with Lee, who finished at 11 PM the night before
    // (7 hours' rest); Mike on two runs at once, both on Van 1; Van 1's insurance and Mike's licence lapsed.
    const waiting = await f.rider('Wes', { targetAt: t(9), serviceDate: tomorrow });
    const full = await f.run({ vanId: f.van3.id, driverUserId: f.lee.id, departAt: t(6), serviceDate: tomorrow });
    for (let i = 0; i < 9; i++) await f.rider(`R${i}`, { status: 'SCHEDULED', runId: full.id, targetAt: t(7), serviceDate: tomorrow });
    const m1 = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: t(6), serviceDate: tomorrow });
    const m2 = await f.run({ vanId: f.van1.id, driverUserId: f.mike.id, departAt: t(7), serviceDate: tomorrow });
    const night = await f.run({ vanId: f.van2.id, driverUserId: f.lee.id, departAt: wall(f.today, 21), serviceDate: f.today, status: 'COMPLETED', endedAt: wall(f.today, 23) });
    await prisma.van.update({ where: { id: f.van1.id }, data: { insuranceExpiresAt: new Date(`${f.today}T00:00:00Z`) } });
    await prisma.driverProfile.create({ data: { userId: f.mike.id, licenceExpiresAt: new Date(`${f.today}T00:00:00Z`) } });
    await prisma.driverProfile.create({ data: { userId: f.lee.id, licenceExpiresAt: new Date('2030-01-01T00:00:00Z') } });

    const bad = (await f.desk.get(`/transport/readiness?date=${tomorrow}`)).body as TransportReadiness;
    const item = (b: TransportReadiness, id: string) => b.items.find((i) => i.id === id)!;
    expect(bad).toMatchObject({ date: tomorrow, ready: false, riders: 10, runs: 3 });
    expect(item(bad, 'riders_placed')).toMatchObject({ ok: false, count: 1, detail: '1 rider has no van yet.', action: { kind: 'plan' } });
    expect(item(bad, 'seats')).toMatchObject({ ok: false, count: 1, detail: "Van 3's 6:00 AM run has 9 riders for 8 seats.", action: { kind: 'open_board', target: full.id } });
    expect(item(bad, 'drivers_assigned_ok')).toMatchObject({ ok: false, count: 2, action: { kind: 'open_board' } });
    expect(item(bad, 'drivers_assigned_ok').detail).toBe('Mike Chen is on two runs at once — 6:00 AM and 7:00 AM. 1 more driver too.');
    expect(item(bad, 'credentials')).toMatchObject({ ok: false, count: 1, action: { kind: 'open_setup_drivers' } });
    expect(item(bad, 'credentials').detail).toMatch(/^Mike Chen's driver's licence lapsed \w{3} \d+\.$/);
    expect(item(bad, 'vans_ready')).toMatchObject({ ok: false, count: 1, action: { kind: 'open_setup_vans' } });
    expect(item(bad, 'vans_ready').detail).toMatch(/^Van 1's insurance lapsed \w{3} \d+\.$/);
    expect(item(bad, 'vans_double_booked')).toMatchObject({ ok: false, count: 1, detail: 'Van 1 is on two runs at once — 6:00 AM and 7:00 AM.', action: { target: m2.id } });

    // Mike's second run moves to Van 2 later; Lee's night ended at 9:30 PM; seats, papers and the waiting rider fixed.
    await prisma.ride.update({ where: { id: waiting.id }, data: { status: 'CANCELLED' } });
    await prisma.ride.updateMany({ where: { runId: full.id, associate: { firstName: 'R8' } }, data: { status: 'CANCELLED' } });
    await prisma.rideRun.update({ where: { id: m2.id }, data: { vanId: f.van2.id, departAt: t(11) } });
    await prisma.rideRun.update({ where: { id: night.id }, data: { endedAt: wall(f.today, 21, 30) } });
    await prisma.van.update({ where: { id: f.van1.id }, data: { insuranceExpiresAt: null } });
    await prisma.driverProfile.update({ where: { userId: f.mike.id }, data: { licenceExpiresAt: new Date('2030-01-01T00:00:00Z') } });
    const good = (await f.desk.get(`/transport/readiness?date=${tomorrow}`)).body as TransportReadiness;
    expect(good.items.filter((i) => !i.ok).map((i) => i.id)).toEqual([]);
    expect(good).toMatchObject({ ready: true, riders: 8, runs: 3 });
    expect(m1.id).toBeTruthy();
  });

  it('counts a driver over the day’s hours', async () => {
    const f = await fleet();
    const tomorrow = addDays(f.today, 1);
    await prisma.transportSettings.update({ where: { tenantId: ALTO }, data: { driverMaxHoursPerDay: 3 } });
    const [y, mo, d] = tomorrow.split('-').map(Number) as [number, number, number];
    await f.run({ vanId: f.van1.id, driverUserId: f.lee.id, departAt: zonedWallTimeToUtcInstant(y, mo, d, 6 * 60, 'America/New_York'), serviceDate: tomorrow });
    await f.run({ vanId: f.van1.id, driverUserId: f.lee.id, departAt: zonedWallTimeToUtcInstant(y, mo, d, 14 * 60, 'America/New_York'), serviceDate: tomorrow });
    const r = (await f.desk.get(`/transport/readiness?date=${tomorrow}`)).body as TransportReadiness;
    expect(r.items.find((i) => i.id === 'drivers_assigned_ok')).toMatchObject({ ok: false, count: 1, detail: 'Lee Park is down for 4.0 hours — the most is 3.' });
  });
});

describe('who may read it, and whose vans', () => {
  it('a driver can’t read the desk’s board or readiness; an associate can’t either', async () => {
    const f = await fleet();
    const driver = await loginAs(f.mike.email);
    expect((await driver.get('/transport/ops')).status).toBe(403);
    expect((await driver.get('/transport/readiness')).status).toBe(403);
    const a = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    expect((await (await loginAs(user.email)).get('/transport/ops')).status).toBe(403);
  });

  it('another tenant’s vans, runs and riders never reach the board', async () => {
    const f = await fleet();
    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'transport-two', name: 'Transport Two' }, update: {} });
    const theirVan = await prisma.van.create({ data: { name: 'Their Van', capacity: 10, tenantId: T2 } });
    const theirDriver = await createUser({ role: 'DRIVER' });
    await prisma.user.update({ where: { id: theirDriver.user.id }, data: { tenantId: T2 } });
    const theirRun = await prisma.rideRun.create({ data: { vanId: theirVan.id, driverUserId: theirDriver.user.id, direction: 'TO_WORK', serviceDate: f.today, departAt: f.at(-60), createdById: theirDriver.user.id, tenantId: T2 } });
    const ops = (await f.desk.get('/transport/ops')).body as TransportOpsBoard;
    expect(ops.vans.map((v) => v.name)).toEqual(['Van 1', 'Van 2', 'Van 3']);
    expect(JSON.stringify(ops)).not.toContain(theirRun.id);
    const ready = (await f.desk.get(`/transport/readiness?date=${f.today}`)).body as TransportReadiness;
    expect(ready.runs).toBe(0);
  });
});

describe('the double-booking rule (lib/transportConflicts)', () => {
  it('is the Gantt’s: busy from 15 minutes before leaving to the end, or two hours after the start', () => {
    const base = new Date('2026-10-28T10:00:00Z');
    const mk = (id: string, vanId: string, driverUserId: string, minutes: number, extra: { status?: string; endedAt?: Date; startedAt?: Date } = {}) => ({
      id,
      vanId,
      driverUserId,
      status: extra.status ?? 'PLANNED',
      departAt: new Date(base.getTime() + minutes * M),
      startedAt: extra.startedAt ?? null,
      endedAt: extra.endedAt ?? null,
    });
    // Ends exactly where the next one's lead begins: no clash.
    expect(conflictPairs([mk('a', 'v1', 'd1', 0), mk('b', 'v1', 'd2', 135)])).toEqual([]);
    // One minute earlier: one minute shared.
    expect(conflictPairs([mk('a', 'v1', 'd1', 0), mk('b', 'v1', 'd2', 134)])).toEqual([{ kind: 'van', a: 'a', b: 'b', overlapMinutes: 1 }]);
    // A run that ended early frees the van.
    expect(conflictPairs([mk('a', 'v1', 'd1', 0, { status: 'COMPLETED', startedAt: base, endedAt: new Date(base.getTime() + 30 * M) }), mk('b', 'v1', 'd1', 60)])).toEqual([]);
    // Same van and driver: two conflicts, both runs carry both.
    const both = runConflicts([mk('a', 'v1', 'd1', 0), mk('b', 'v1', 'd1', 30)]);
    expect(both.get('a')).toEqual([{ kind: 'van', runId: 'b', overlapMinutes: 105 }, { kind: 'driver', runId: 'b', overlapMinutes: 105 }]);
    expect(both.get('b')).toHaveLength(2);
  });
});
