import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { dateKeyInZone, utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';

/**
 * The year in attendance (GET /attendance/calendar): one count per day for
 * the last 365 days — call-outs, no-shows or late arrivals — each on its
 * store's own day, inside the caller's reach.
 *
 * Every day is seeded relative to today on the company's calendar
 * (Eastern), so the file passes at any hour, CI's UTC included.
 */

const HOUR = 3_600_000;
const TZ = 'America/New_York';
const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}
const today = () => dateKeyInZone(new Date(), TZ);
/** A wall-clock time on a day in Eastern time. */
const at = (key: string, hour: number, minute = 0) => new Date(utcInstantOfLocalMidnight(key, TZ).getTime() + hour * HOUR + minute * 60_000);
/** What lib/attendance writes as occurredOn: the UTC date of the shift's start (deliberately not the store's day). */
const utcDate = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);

async function store(name: string) {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  return { client, site };
}

async function shift(clientId: string, siteId: string, startsAt: Date, associateId: string) {
  return prisma.shift.create({
    data: {
      clientId,
      locationId: siteId,
      position: 'Housekeeper',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 6 * HOUR),
      status: 'ASSIGNED',
      assignedAssociateId: associateId,
      publishedAt: new Date(startsAt.getTime() - 7 * 24 * HOUR),
    },
  });
}

async function callOut(s: { id: string; clientId: string | null; locationId: string | null }, associateId: string, status: 'CONFIRMED' | 'PENDING' = 'CONFIRMED') {
  return prisma.callOut.create({ data: { shiftId: s.id, associateId, clientId: s.clientId, locationId: s.locationId, channel: 'SMS', minutesBeforeStart: 120, status } });
}

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

type Day = { date: string; value: number };

describe('GET /attendance/calendar', () => {
  it('counts each call-out once, on its store’s own day — an Eastern evening shift is that evening, not the next UTC date', async () => {
    const a = await store('Harbor Inn');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const k1 = addDays(today(), -10);
    const k2 = addDays(today(), -20);
    const k3 = addDays(today(), -30);

    // k1: a 9:30 PM call-out (its UTC date is k1 + 1), a missed shift a
    // time-off request covered (a CALL_OUT event, no log row), and one
    // both logged and an event — counted once.
    const evening = await shift(a.client.id, a.site.id, at(k1, 21, 30), ana.id);
    expect(dateKeyInZone(evening.startsAt, 'UTC')).toBe(addDays(k1, 1));
    await callOut(evening, ana.id);
    const covered = await shift(a.client.id, a.site.id, at(k1, 9), ana.id);
    const both = await shift(a.client.id, a.site.id, at(k1, 14), ana.id);
    await callOut(both, ana.id);
    // k2: a text read as "can't make it", never confirmed — not a call-out yet;
    // and a CALL_OUT event with no shift, placed by its occurredOn.
    await callOut(await shift(a.client.id, a.site.id, at(k2, 9), ana.id), ana.id, 'PENDING');
    // k3: an excused call-out is still a call-out (nobody came) — an excused
    // CALL_OUT event, and a logged call-out the policy excused.
    const excused = await shift(a.client.id, a.site.id, at(k3, 9), ana.id);
    const excusedLog = await callOut(await shift(a.client.id, a.site.id, at(k3, 15), ana.id), ana.id);
    await prisma.callOut.update({ where: { id: excusedLog.id }, data: { excused: true, excusedWhy: 'Jury duty' } });
    // Older than a year: outside the calendar.
    const old = await shift(a.client.id, a.site.id, at(addDays(today(), -400), 9), ana.id);
    await callOut(old, ana.id);
    await prisma.attendanceEvent.createMany({
      data: [
        { associateId: ana.id, shiftId: covered.id, clientId: a.client.id, kind: 'CALL_OUT', points: 1, occurredOn: utcDate(covered.startsAt) },
        { associateId: ana.id, shiftId: both.id, clientId: a.client.id, kind: 'CALL_OUT', points: 1, occurredOn: utcDate(both.startsAt) },
        { associateId: ana.id, shiftId: null, clientId: a.client.id, kind: 'CALL_OUT', points: 1, occurredOn: new Date(`${k2}T00:00:00Z`), source: 'MANUAL' },
        { associateId: ana.id, shiftId: excused.id, clientId: a.client.id, kind: 'CALL_OUT', points: 1, occurredOn: utcDate(excused.startsAt), excusedAt: new Date() },
      ],
    });

    const res = await (await hr()).get('/attendance/calendar');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      metric: 'callouts',
      to: today(),
      from: addDays(today(), -364),
      siteId: null,
      firstDay: 6,
      total: 6,
      busiest: { date: k1, value: 3 },
    });
    // Only days with any, oldest first; nothing on the UTC date after k1.
    expect(res.body.days).toEqual([
      { date: k3, value: 2 },
      { date: k2, value: 1 },
      { date: k1, value: 3 },
    ]);
    const dow = (key: string) => new Date(`${key}T12:00:00Z`).getUTCDay();
    expect(res.body.weekdayTotals).toHaveLength(7);
    expect(res.body.weekdayTotals.reduce((n: number, v: number) => n + v, 0)).toBe(6);
    expect(res.body.weekdayTotals[dow(k1)]).toBeGreaterThanOrEqual(3);
  });

  it('no-shows and late arrivals: each metric counts only its own kind, an excused one is left out, an evening shift lands on its local day', async () => {
    const a = await store('Harbor Inn');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const k1 = addDays(today(), -3);
    const k2 = addDays(today(), -40);
    const k3 = addDays(today(), -100);

    const lateNight = await shift(a.client.id, a.site.id, at(k1, 22), ana.id);
    const excusedNoShow = await shift(a.client.id, a.site.id, at(k2, 6), ana.id);
    const lateMorning = await shift(a.client.id, a.site.id, at(k2, 9), ana.id);
    const lateEvening = await shift(a.client.id, a.site.id, at(k2, 20, 45), ana.id);
    const excusedLate = await shift(a.client.id, a.site.id, at(k3, 9), ana.id);
    await callOut(await shift(a.client.id, a.site.id, at(k3, 13), ana.id), ana.id);
    const ev = (s: { id: string; startsAt: Date }, kind: 'LATE' | 'NO_CALL_NO_SHOW', excusedAt: Date | null = null) => ({
      associateId: ana.id,
      shiftId: s.id,
      clientId: a.client.id,
      kind,
      points: kind === 'LATE' ? 0.5 : 2,
      occurredOn: utcDate(s.startsAt),
      excusedAt,
    });
    await prisma.attendanceEvent.createMany({
      data: [
        ev(lateNight, 'NO_CALL_NO_SHOW'),
        ev(excusedNoShow, 'NO_CALL_NO_SHOW', new Date()),
        ev(lateMorning, 'LATE'),
        ev(lateEvening, 'LATE'),
        ev(excusedLate, 'LATE', new Date()),
      ],
    });

    const h = await hr();
    const noShows = await h.get('/attendance/calendar?metric=noshows');
    expect(noShows.status).toBe(200);
    expect(noShows.body).toMatchObject({ metric: 'noshows', total: 1, days: [{ date: k1, value: 1 }], busiest: { date: k1, value: 1 } });
    const late = await h.get('/attendance/calendar?metric=late');
    expect(late.body).toMatchObject({ metric: 'late', total: 2, days: [{ date: k2, value: 2 }] });
    const callOuts = await h.get('/attendance/calendar?metric=callouts');
    expect(callOuts.body).toMatchObject({ total: 1, days: [{ date: k3, value: 1 }] });
  });

  it('ends today on the company calendar and reaches back `days` days — at most 371; bad input is refused', async () => {
    const a = await store('Harbor Inn');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const first = addDays(today(), -6);
    const before = addDays(today(), -7);
    for (const key of [first, before, today()]) await callOut(await shift(a.client.id, a.site.id, at(key, 0, 30), ana.id), ana.id);

    const h = await hr();
    const week = await h.get('/attendance/calendar?days=7');
    expect(week.status).toBe(200);
    expect(week.body).toMatchObject({ from: first, to: today(), total: 2 });
    expect(week.body.days.map((d: Day) => d.date)).toEqual([first, today()]);
    // A tie for the busiest day goes to the latest.
    expect(week.body.busiest).toEqual({ date: today(), value: 1 });

    const longest = await h.get('/attendance/calendar?days=371');
    expect(longest.status).toBe(200);
    expect(longest.body).toMatchObject({ from: addDays(today(), -370), total: 3 });

    for (const q of ['days=372', 'days=0', 'days=-5', 'days=abc', 'days=7.5', 'metric=overtime', 'metric=sleep', 'siteId=store-12']) {
      expect((await h.get(`/attendance/calendar?${q}`)).status, q).toBe(400);
    }
    const nothing = await h.get('/attendance/calendar?metric=late');
    expect(nothing.body).toMatchObject({ total: 0, days: [], busiest: null, weekdayTotals: [0, 0, 0, 0, 0, 0, 0] });
  });

  it('a store-bound manager sees only their store, a site filter narrows, another tenant’s days never appear, an associate is refused', async () => {
    const { client, site: north } = await store('Two Store Client');
    const south = await prisma.site.create({ data: { name: 'South Store', clientId: client.id, timezone: TZ } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'North' });
    const sam = await createAssociate({ firstName: 'Sam', lastName: 'South' });
    const kn = addDays(today(), -5);
    const ks = addDays(today(), -8);
    await callOut(await shift(client.id, north.id, at(kn, 9), ana.id), ana.id);
    const southShift = await shift(client.id, south.id, at(ks, 9), sam.id);
    await callOut(southShift, sam.id);
    // South's late arrival stays with South.
    await prisma.attendanceEvent.create({
      data: { associateId: sam.id, shiftId: southShift.id, clientId: client.id, kind: 'LATE', points: 0.5, occurredOn: utcDate(southShift.startsAt) },
    });

    // Another tenant, on a day of its own and on North's day.
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const theirClient = await prisma.client.create({ data: { name: 'Their Hotel', industry: 'hospitality', status: 'ACTIVE', tenantId: T2 } });
    const theirSite = await prisma.site.create({ data: { name: 'Their Site', clientId: theirClient.id, timezone: TZ, tenantId: T2 } });
    const them = await prisma.associate.create({ data: { firstName: 'Tia', lastName: 'Other', email: 'tia@tenant-two.example', tenantId: T2 } });
    const kt = addDays(today(), -12);
    for (const key of [kt, kn]) {
      const s = await prisma.shift.create({
        data: { tenantId: T2, clientId: theirClient.id, locationId: theirSite.id, position: 'Housekeeper', startsAt: at(key, 9), endsAt: at(key, 15), status: 'ASSIGNED', assignedAssociateId: them.id, publishedAt: at(key, 0) },
      });
      await prisma.callOut.create({ data: { tenantId: T2, shiftId: s.id, associateId: them.id, clientId: theirClient.id, locationId: theirSite.id, channel: 'SMS', minutesBeforeStart: 60 } });
      await prisma.attendanceEvent.createMany({
        data: [
          { tenantId: T2, associateId: them.id, shiftId: s.id, clientId: theirClient.id, kind: 'LATE', points: 0.5, occurredOn: utcDate(s.startsAt) },
          { tenantId: T2, associateId: them.id, shiftId: null, clientId: theirClient.id, kind: 'NO_CALL_NO_SHOW', points: 2, occurredOn: new Date(`${key}T00:00:00Z`), source: 'MANUAL' },
        ],
      });
    }

    const h = await hr();
    const all = await h.get('/attendance/calendar');
    expect(all.body.days).toEqual([
      { date: ks, value: 1 },
      { date: kn, value: 1 },
    ]);
    expect((await h.get('/attendance/calendar?metric=late')).body).toMatchObject({ total: 1, days: [{ date: ks, value: 1 }] });
    expect((await h.get('/attendance/calendar?metric=noshows')).body).toMatchObject({ total: 0, days: [] });
    const southOnly = await h.get(`/attendance/calendar?siteId=${south.id}`);
    expect(southOnly.body).toMatchObject({ siteId: south.id, total: 1, days: [{ date: ks, value: 1 }] });
    // Another tenant's site, asked for by id, is just empty.
    expect((await h.get(`/attendance/calendar?siteId=${theirSite.id}`)).body).toMatchObject({ total: 0, days: [] });

    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [north.id] } });
    const o = await loginAs(agent(), ops.email);
    const mine = await o.get('/attendance/calendar');
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ total: 1, days: [{ date: kn, value: 1 }] });
    expect((await o.get('/attendance/calendar?metric=late')).body).toMatchObject({ total: 0, days: [] });
    // Naming the other store doesn't widen the reach.
    expect((await o.get(`/attendance/calendar?siteId=${south.id}`)).body).toMatchObject({ total: 0, days: [] });

    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    expect((await (await loginAs(agent(), assoc.email)).get('/attendance/calendar')).status).toBe(403);
  });
});
