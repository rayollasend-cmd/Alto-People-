import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { TransportOpsBoard } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { setGeocoderForTests } from '../../lib/geocode.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import { NOT_RUN_NOTE, NOT_RUN_RIDE_REASON, closeRunsThatNeverRan } from '../../lib/transportNotRun.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The "didn't run" sweep (transport upgrade 2026-10-28): a planned run that
 * never left — three hours past its departure, or from a day already over —
 * is cancelled and stamped, its riders' rides cancelled "The van didn't
 * run" and never charged; the desk hears once per run, each rider once in
 * their language; a second sweep changes nothing. The board marks the run
 * notRun, the ops board lists it, and the driver's two "runs today" counts
 * agree.
 */

const ALTO = '00000000-0000-4000-8000-000000000001';
const M = 60_000;

beforeEach(async () => {
  await truncateAll();
  await prisma.transportSettings.upsert({ where: { tenantId: ALTO }, create: { preTripRequired: false }, update: { preTripRequired: false } });
  setGeocoderForTests(async () => null);
});
afterEach(() => setGeocoderForTests(null));
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
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const today = dateKeyInZone(now, store.timezone);
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mikeA = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  const { user: mike } = await createUser({ role: 'DRIVER', associateId: mikeA.id });
  const van = await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 12 } });
  async function run(departAt: Date, o: { serviceDate?: string; status?: 'PLANNED' | 'ACTIVE' | 'COMPLETED' } = {}) {
    return prisma.rideRun.create({
      data: {
        vanId: van.id,
        driverUserId: mike.id,
        direction: 'TO_WORK',
        serviceDate: o.serviceDate ?? dateKeyInZone(departAt, store.timezone),
        departAt,
        status: o.status ?? 'PLANNED',
        startedAt: o.status && o.status !== 'PLANNED' ? departAt : null,
        endedAt: o.status === 'COMPLETED' ? new Date(departAt.getTime() + 60 * M) : null,
        createdById: director.id,
      },
    });
  }
  async function rider(firstName: string, runId: string | null, o: { pickupAt: Date; status?: 'SCHEDULED' | 'REQUESTED'; language?: string }) {
    const a = await createAssociate({ firstName, lastName: 'Rider' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    if (o.language) await prisma.user.update({ where: { id: user.id }, data: { language: o.language } });
    const ride = await prisma.ride.create({
      data: {
        associateId: a.id,
        direction: 'TO_WORK',
        locationId: store.id,
        address: '9 Harbor Rd',
        targetAt: new Date(o.pickupAt.getTime() + 40 * M),
        serviceDate: dateKeyInZone(o.pickupAt, store.timezone),
        status: o.status ?? 'SCHEDULED',
        runId,
        pickupOrder: 1,
        pickupAt: o.pickupAt,
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: director.id,
      },
    });
    return { user, ride };
  }
  return { now, at, store, today, director, mike, van, run, rider };
}

describe('closeRunsThatNeverRan', () => {
  it('closes a planned run three hours past its departure: run cancelled and stamped, rides cancelled and never charged, everyone told once', async () => {
    const f = await fleet();
    const stale = await f.run(f.at(-200));
    const ana = await f.rider('Ana', stale.id, { pickupAt: f.at(-190) });
    const bo = await f.rider('Bo', stale.id, { pickupAt: f.at(-185), language: 'es' });
    // Still inside the three hours, and one that left: both untouched.
    const recent = await f.run(f.at(-170));
    const cy = await f.rider('Cy', recent.id, { pickupAt: f.at(-160) });
    const out = await f.run(f.at(-400), { status: 'ACTIVE' });

    const first = await closeRunsThatNeverRan(f.now);
    expect(first).toEqual({ closed: 1, rides: 2, runIds: [stale.id] });
    const run = await prisma.rideRun.findUniqueOrThrow({ where: { id: stale.id } });
    expect(run).toMatchObject({ status: 'CANCELLED', startedAt: null, notes: NOT_RUN_NOTE });
    expect(run.autoClosedAt).toEqual(f.now);
    for (const id of [ana.ride.id, bo.ride.id]) {
      expect(await prisma.ride.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'CANCELLED', cancelReason: NOT_RUN_RIDE_REASON, chargeCents: 0, waivedAt: null, chargedRunId: null });
    }
    expect((await prisma.rideRun.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe('PLANNED');
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: cy.ride.id } })).status).toBe('SCHEDULED');
    expect((await prisma.rideRun.findUniqueOrThrow({ where: { id: out.id } })).status).toBe('ACTIVE');

    await flushPendingNotifications();
    await flushPendingAudits();
    const told = async () => ({
      desk: await prisma.notification.findMany({ where: { recipientUserId: f.director.id, channel: 'IN_APP' }, select: { subject: true, body: true } }),
      ana: await prisma.notification.findMany({ where: { recipientUserId: ana.user.id, channel: 'IN_APP' }, select: { subject: true } }),
      bo: await prisma.notification.findMany({ where: { recipientUserId: bo.user.id, channel: 'IN_APP' }, select: { subject: true } }),
      cy: await prisma.notification.count({ where: { recipientUserId: cy.user.id } }),
    });
    const once = await told();
    expect(once.desk).toHaveLength(1);
    expect(once.desk[0]!.subject).toMatch(/^Van 1's \d+:\d\d (AM|PM) run didn't run$/);
    expect(once.desk[0]!.body).toBe("Mike Chen never started it, so it was closed. Its 2 riders were told the ride is off — nobody was charged.");
    expect(once.ana.map((n) => n.subject)).toEqual([expect.stringMatching(/^Your \d+:\d\d (AM|PM) ride didn't run — you won't be charged$/)]);
    expect(once.bo.map((n) => n.subject)).toEqual([expect.stringMatching(/^Su viaje de las .+ no salió — no se le cobrará$/)]);
    expect(once.cy).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'transport.run_not_run', entityId: stale.id } })).toBe(1);

    // Idempotent: the second sweep finds nothing, and nobody hears twice.
    expect(await closeRunsThatNeverRan(f.now)).toEqual({ closed: 0, rides: 0, runIds: [] });
    await flushPendingNotifications();
    const twice = await told();
    expect([twice.desk.length, twice.ana.length, twice.bo.length]).toEqual([1, 1, 1]);
  });

  it('closes yesterday’s planned runs whatever their hour, and never touches a run that left or finished', async () => {
    const f = await fleet();
    const yesterday = new Date(Date.parse(`${f.today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const late = await f.run(f.at(-60), { serviceDate: yesterday });
    const done = await f.run(f.at(-26 * 60), { status: 'COMPLETED' });
    const r = await closeRunsThatNeverRan(f.now);
    expect(r.runIds).toEqual([late.id]);
    expect((await prisma.rideRun.findUniqueOrThrow({ where: { id: done.id } })).status).toBe('COMPLETED');
    // Nobody on it: the desk still hears, and says so.
    await flushPendingNotifications();
    expect((await prisma.notification.findFirstOrThrow({ where: { recipientUserId: f.director.id } })).body).toMatch(/^Mike Chen never started it on \w{3}, \w{3} \d+, so it was closed\. Nobody was on it\.$/);
  });

  it('the board marks the run notRun, the ops board lists it, and the driver still sees it as "didn\'t run"', async () => {
    const f = await fleet();
    const stale = await f.run(f.at(-240));
    await f.rider('Ana', stale.id, { pickupAt: f.at(-230) });
    await closeRunsThatNeverRan(f.now);
    const desk = await loginAs(f.director.email);
    const board = (await desk.get(`/transport/board?date=${f.today}`)).body as { runs: Array<{ id: string; notRun: boolean; status: string; autoClosedAt: string | null }> };
    expect(board.runs.find((r) => r.id === stale.id)).toMatchObject({ notRun: true, status: 'CANCELLED', autoClosedAt: f.now.toISOString() });
    const ops = (await desk.get('/transport/ops')).body as TransportOpsBoard;
    const item = ops.exceptions.find((e) => e.kind === 'didnt_run')!;
    expect(item).toMatchObject({ id: `didnt_run:${stale.id}`, severity: 'medium', runId: stale.id, detail: 'It never started, so it was closed and its 1 rider told — nobody was charged.' });
    expect(item.title).toMatch(/^Van 1's \d+:\d\d (AM|PM) run didn't run$/);
    // A cancelled run is not a run that never left: no "hasn't left" item for it.
    expect(ops.exceptions.some((e) => e.kind === 'not_started')).toBe(false);
    // The driver's list keeps today's and yesterday's runs that never left, marked; no other cancelled run.
    const yesterday = new Date(Date.parse(`${f.today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const lastNight = await f.run(f.at(-20 * 60), { serviceDate: yesterday });
    const longAgo = await f.run(f.at(-3 * 24 * 60));
    await closeRunsThatNeverRan(f.now);
    const calledOff = await f.run(f.at(120));
    await prisma.rideRun.update({ where: { id: calledOff.id }, data: { status: 'CANCELLED', notes: 'Not needed' } });
    const driver = (await (await loginAs(f.mike.email)).get('/transport/driver/runs')).body as {
      runs: Array<{ id: string; status: string; notRun: boolean }>;
      counts: { total: number; done: number; active: number };
    };
    expect(driver.runs.filter((r) => r.notRun).map((r) => r.id).sort()).toEqual([stale.id, lastNight.id].sort());
    expect(driver.runs.find((r) => r.id === stale.id)).toMatchObject({ status: 'CANCELLED', notRun: true });
    expect(driver.runs.map((r) => r.id)).not.toContain(longAgo.id);
    expect(driver.runs.map((r) => r.id)).not.toContain(calledOff.id);
    // A run that didn't run is not a run today.
    expect(driver.counts).toEqual({ total: 0, done: 0, active: 0 });
  });
});

describe('the driver’s “runs today”', () => {
  it('is one count: the Today card and the runs list agree (today’s runs that aren’t cancelled; done = completed)', async () => {
    const f = await fleet();
    await f.run(f.at(-120), { status: 'COMPLETED' });
    await f.run(f.at(-30), { status: 'ACTIVE' });
    await f.run(f.at(120));
    const cancelled = await f.run(f.at(180));
    await prisma.rideRun.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } });
    // Tomorrow's and yesterday's runs are on the list but not today's count.
    await f.run(f.at(24 * 60));
    await f.run(f.at(-24 * 60), { status: 'COMPLETED' });
    const mike = await loginAs(f.mike.email);
    const today = (await mike.get('/transport/driver/today')).body as { runs: { total: number; done: number; active: number } };
    const list = (await mike.get('/transport/driver/runs')).body as { counts: { total: number; done: number; active: number }; runs: unknown[] };
    expect(today.runs).toEqual({ total: 3, done: 1, active: 1 });
    expect(list.counts).toEqual(today.runs);
    expect(list.runs).toHaveLength(5);
  });
});

describe('GET /transport/driver/today — the pay sheet', () => {
  it('carries the dispatch line, the earnings engine’s week and the next payday from the driver’s schedule', async () => {
    const f = await fleet();
    await prisma.transportSettings.update({ where: { tenantId: ALTO }, data: { dispatchPhone: '(850) 555-0199' } });
    const mike = await loginAs(f.mike.email);
    const before = (await mike.get('/transport/driver/today')).body;
    expect(before.dispatchPhone).toBe('(850) 555-0199');
    // On no pay schedule: no payday is promised.
    expect(before.nextPayday).toBeNull();
    expect(before.earnings).toMatchObject({ rateSource: 'default', currentRatePerHour: expect.any(Number) });
    expect(before.earnings.days).toHaveLength(7);
    expect(before.earnings.days[0]).toEqual({ date: expect.any(String), workedMinutes: expect.any(Number), workedAmount: expect.any(Number), scheduledMinutes: expect.any(Number), scheduledAmount: expect.any(Number) });
    expect(before.earnings.overtime).toEqual({ thresholdHours: 40, multiplier: expect.any(Number), unlocked: false, otHoursSoFar: 0, projectedOtHours: expect.any(Number) });
    expect('takeHome' in before.earnings).toBe(true);

    // Biweekly Sat → Fri, paid the Friday after, anchored on a recent Saturday.
    const anchor = new Date(`${f.today}T00:00:00Z`);
    anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 1) % 7));
    const schedule = await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: anchor, payDateOffsetDays: 7 } });
    const mikeUser = await prisma.user.findUniqueOrThrow({ where: { id: f.mike.id }, select: { associateId: true } });
    await prisma.associate.update({ where: { id: mikeUser.associateId! }, data: { payrollScheduleId: schedule.id } });
    const after = (await mike.get('/transport/driver/today')).body;
    // The first payday after today: a two-week Saturday → Friday period, paid the Friday after.
    const plus = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const p = after.nextPayday as { payDate: string; periodStart: string; periodEnd: string };
    expect(Object.keys(p).sort()).toEqual(['payDate', 'periodEnd', 'periodStart']);
    expect(p.periodEnd).toBe(plus(p.periodStart, 13));
    // Seven days after the period (a day or two earlier when that Friday is a bank holiday).
    expect(p.payDate <= plus(p.periodEnd, 7) && p.payDate >= plus(p.periodEnd, 4)).toBe(true);
    expect(p.payDate > f.today).toBe(true);
    expect(plus(p.payDate, -14) <= f.today).toBe(true);
  });

  it('a driver with no person record gets no earnings and no payday, and the dispatch line is null when none is set', async () => {
    const f = await fleet();
    const { user } = await createUser({ role: 'DRIVER' });
    const body = (await (await loginAs(user.email)).get('/transport/driver/today')).body;
    expect(body).toMatchObject({ associateId: null, earnings: null, nextPayday: null, dispatchPhone: null, runs: { total: 0, done: 0, active: 0 } });
    expect(f.today).toBeTruthy();
  });
});
