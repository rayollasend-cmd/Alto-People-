import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { dateKeyInZone, startOfWeekUTC } from '../../lib/timeAnomalies.js';

/**
 * Attendance insights: the weekly trend lines (fill, no-shows, call-outs,
 * lates, overtime), the heatmap by day × store (× hour at one store), the
 * "not in yet" list, and a manager's team hours — each inside the caller's
 * reach.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TZ = 'America/New_York';

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function store(name: string) {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  return { client, site };
}

async function shift(clientId: string, siteId: string, startsAt: Date, hours: number, data: { status?: 'OPEN' | 'ASSIGNED' | 'COMPLETED'; associateId?: string } = {}) {
  return prisma.shift.create({
    data: {
      clientId,
      locationId: siteId,
      position: 'Housekeeper',
      startsAt,
      endsAt: new Date(startsAt.getTime() + hours * HOUR),
      status: data.status ?? (data.associateId ? 'ASSIGNED' : 'OPEN'),
      assignedAssociateId: data.associateId ?? null,
      publishedAt: new Date(startsAt.getTime() - 7 * DAY),
    },
  });
}

/** Last week's Sunday 9:00 AM Eastern-ish — well inside a complete workweek. */
function lastWeekDay(offsetDays: number, hour = 9) {
  const start = startOfWeekUTC(new Date(startOfWeekUTC(new Date()).getTime() - 3 * DAY));
  return new Date(start.getTime() + offsetDays * DAY + hour * HOUR);
}

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

describe('GET /attendance/trends', () => {
  it('counts fill, no-shows, call-outs once, lates and overtime per workweek', async () => {
    const a = await store('Harbor Inn');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Cole' });
    // Last week: three filled shifts, one left open → 75%.
    const s1 = await shift(a.client.id, a.site.id, lastWeekDay(1), 8, { associateId: ana.id, status: 'COMPLETED' });
    const s2 = await shift(a.client.id, a.site.id, lastWeekDay(2), 8, { associateId: ben.id });
    const s3 = await shift(a.client.id, a.site.id, lastWeekDay(3), 8, { associateId: ben.id });
    await shift(a.client.id, a.site.id, lastWeekDay(4), 8);
    // A late (counted), an excused late (not), a no-show; one call-out logged twice over.
    await prisma.attendanceEvent.createMany({
      data: [
        { associateId: ana.id, shiftId: s1.id, clientId: a.client.id, kind: 'LATE', points: 0.5, occurredOn: lastWeekDay(1) },
        { associateId: ben.id, shiftId: s2.id, clientId: a.client.id, kind: 'LATE', points: 0.5, occurredOn: lastWeekDay(2), excusedAt: new Date() },
        { associateId: ben.id, shiftId: s3.id, clientId: a.client.id, kind: 'CALL_OUT', points: 1, occurredOn: lastWeekDay(3) },
        { associateId: ana.id, shiftId: null, clientId: a.client.id, kind: 'NO_CALL_NO_SHOW', points: 2, occurredOn: lastWeekDay(5), source: 'MANUAL' },
      ],
    });
    await prisma.callOut.create({ data: { shiftId: s3.id, associateId: ben.id, clientId: a.client.id, locationId: a.site.id, channel: 'SMS', minutesBeforeStart: 120 } });
    // Ana: five 9-hour days last week = 45 → 5 hours of overtime.
    for (let d = 0; d < 5; d++) {
      const at = lastWeekDay(d + 1, 7);
      await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: a.client.id, locationId: a.site.id, clockInAt: at, clockOutAt: new Date(at.getTime() + 9 * HOUR), status: 'APPROVED' } });
    }

    const res = await (await hr()).get('/attendance/trends?weeks=8');
    expect(res.status).toBe(200);
    expect(res.body.weeks).toHaveLength(8);
    expect(res.body.fillTargetPct).toBe(95);
    const [current, last] = [res.body.weeks[7], res.body.weeks[6]];
    expect(current.inProgress).toBe(true);
    expect(last).toMatchObject({
      inProgress: false,
      weekStart: dateKeyInZone(startOfWeekUTC(lastWeekDay(1)), TZ),
      scheduledShifts: 4,
      filledShifts: 3,
      fillRatePct: 75,
      lates: 1,
      noCallNoShows: 1,
      callOuts: 1,
      overtimeHours: 5,
    });
    // Weeks are oldest first, one workweek apart.
    expect(res.body.weeks[0].weekStart < last.weekStart).toBe(true);
  });

  it('stays inside the caller’s reach — another client’s supervisor sees none of it, an associate is refused', async () => {
    const a = await store('Harbor Inn');
    const b = await store('Dune Resort');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const s1 = await shift(a.client.id, a.site.id, lastWeekDay(1), 8, { associateId: ana.id });
    await prisma.attendanceEvent.create({ data: { associateId: ana.id, shiftId: s1.id, clientId: a.client.id, kind: 'LATE', points: 0.5, occurredOn: lastWeekDay(1) } });
    await prisma.callOut.create({ data: { shiftId: s1.id, associateId: ana.id, clientId: a.client.id, locationId: a.site.id, channel: 'SMS', minutesBeforeStart: 60 } });

    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: b.client.id });
    const res = await (await loginAs(agent(), sup.email)).get('/attendance/trends');
    expect(res.status).toBe(200);
    const last = res.body.weeks[res.body.weeks.length - 2];
    expect(last).toMatchObject({ scheduledShifts: 0, lates: 0, callOuts: 0, fillRatePct: null });

    // A site filter outside the caller's reach finds nothing, not an error.
    const hrAgent = await hr();
    const elsewhere = await hrAgent.get(`/attendance/trends?siteId=${b.site.id}`);
    expect(elsewhere.body.weeks[6]).toMatchObject({ scheduledShifts: 0, lates: 0 });
    expect((await hrAgent.get('/attendance/trends?weeks=99')).status).toBe(400);

    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    expect((await (await loginAs(agent(), assoc.email)).get('/attendance/trends')).status).toBe(403);
  });
});

describe('GET /attendance/heatmap', () => {
  it('lays lateness on day-of-week × store, and on day × hour at one store', async () => {
    const a = await store('Harbor Inn');
    const b = await store('Dune Resort');
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const day = lastWeekDay(1, 13); // a Sunday, 9 AM Eastern give or take DST
    const sA = await shift(a.client.id, a.site.id, day, 8, { associateId: ana.id });
    const sA2 = await shift(a.client.id, a.site.id, new Date(day.getTime() + 7 * HOUR), 4, { associateId: ana.id });
    const sB = await shift(b.client.id, b.site.id, day, 8, { associateId: ana.id });
    for (const s of [sA, sA2, sB]) {
      await prisma.attendanceEvent.create({ data: { associateId: ana.id, shiftId: s.id, clientId: s.clientId, kind: 'LATE', points: 0.5, occurredOn: day } });
    }
    const from = dateKeyInZone(new Date(day.getTime() - 3 * DAY), TZ);
    const to = dateKeyInZone(new Date(day.getTime() + 3 * DAY), TZ);
    const h = await hr();

    const bySite = await h.get(`/attendance/heatmap?metric=late&from=${from}&to=${to}`);
    expect(bySite.status).toBe(200);
    expect(bySite.body).toMatchObject({ by: 'site', unit: 'count', total: 3, max: 2, days: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'] });
    const harbor = bySite.body.rows.find((r: { label: string }) => r.label === 'Harbor Inn');
    expect(harbor.total).toBe(2);
    const dow = (new Date(`${dateKeyInZone(day, TZ)}T12:00:00Z`).getUTCDay() - 6 + 7) % 7;
    expect(harbor.values[dow]).toBe(2);
    expect(bySite.body.rows[0].label).toBe('Harbor Inn'); // most first

    const byHour = await h.get(`/attendance/heatmap?metric=late&from=${from}&to=${to}&siteId=${a.site.id}`);
    expect(byHour.body.by).toBe('hour');
    expect(byHour.body.total).toBe(2);
    // Two hours with a late, every hour between them listed (empty ones at zero).
    const hours = byHour.body.rows.map((r: { key: string }) => Number(r.key));
    expect(hours[hours.length - 1] - hours[0]).toBe(7);
    expect(byHour.body.rows).toHaveLength(8);

    // Overtime and call-outs answer in the same shape; a bad range is refused.
    expect((await h.get(`/attendance/heatmap?metric=overtime&from=${from}&to=${to}`)).body).toMatchObject({ unit: 'hours', total: 0, rows: [] });
    expect((await h.get(`/attendance/heatmap?metric=callouts&from=${to}&to=${from}`)).status).toBe(400);
    expect((await h.get('/attendance/heatmap?metric=sleep')).status).toBe(400);
  });
});

describe('GET /attendance/late-now', () => {
  it('lists who hasn’t punched in for a started shift — most late first, with call-outs flagged and phones only for those who may call', async () => {
    const a = await store('Harbor Inn');
    const [ana, ben, cy, dee] = await Promise.all([
      createAssociate({ firstName: 'Ana', lastName: 'Reyes' }),
      createAssociate({ firstName: 'Ben', lastName: 'Cole' }),
      createAssociate({ firstName: 'Cy', lastName: 'Park' }),
      createAssociate({ firstName: 'Dee', lastName: 'Ward' }),
    ]);
    await prisma.associate.update({ where: { id: ana.id }, data: { phone: '+15555550101' } });
    const now = Date.now();
    const sAna = await shift(a.client.id, a.site.id, new Date(now - 40 * 60_000), 8, { associateId: ana.id });
    await shift(a.client.id, a.site.id, new Date(now - 12 * 60_000), 8, { associateId: ben.id });
    const sCy = await shift(a.client.id, a.site.id, new Date(now - 5 * 60_000), 8, { associateId: cy.id });
    const sDee = await shift(a.client.id, a.site.id, new Date(now - 20 * 60_000), 8, { associateId: dee.id });
    await shift(a.client.id, a.site.id, new Date(now + 60 * 60_000), 8, { associateId: cy.id }); // not started
    await prisma.timeEntry.create({ data: { associateId: cy.id, clientId: a.client.id, locationId: a.site.id, shiftId: sCy.id, clockInAt: new Date(now - 6 * 60_000), status: 'ACTIVE' } });
    await prisma.callOut.create({ data: { shiftId: sDee.id, associateId: dee.id, clientId: a.client.id, locationId: a.site.id, channel: 'APP', minutesBeforeStart: 30 } });

    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: a.client.id });
    const res = await (await loginAs(agent(), sup.email)).get('/attendance/late-now');
    expect(res.status).toBe(200);
    expect(res.body.canText).toBe(true);
    expect(res.body.people.map((p: { name: string }) => p.name)).toEqual(['Ana Reyes', 'Dee Ward', 'Ben Cole']);
    expect(res.body.people[0]).toMatchObject({ shiftId: sAna.id, status: 'no-show-risk', hasPhone: true, phone: '+15555550101', siteName: 'Harbor Inn', clientId: a.client.id });
    expect(res.body.people[0].minutesLate).toBeGreaterThanOrEqual(39);
    expect(res.body.people[1]).toMatchObject({ status: 'called-out' });
    expect(res.body.people[2]).toMatchObject({ status: 'late', hasPhone: false, phone: null });

    // The watch-only lead sees who, never the number.
    const { user: floor } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: a.client.id });
    const watch = await (await loginAs(agent(), floor.email)).get('/attendance/late-now');
    expect(watch.status).toBe(200);
    expect(watch.body.canText).toBe(false);
    expect(watch.body.people[0]).toMatchObject({ hasPhone: true, phone: null });

    // Another client's supervisor: nobody.
    const b = await store('Dune Resort');
    const { user: other } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: b.client.id });
    expect((await (await loginAs(agent(), other.email)).get('/attendance/late-now')).body.people).toEqual([]);
  });
});

describe('GET /attendance/team-hours', () => {
  it('gives a manager each report’s hours this week — worked, still scheduled, and where it’s heading', async () => {
    const a = await store('Harbor Inn');
    const boss = await createAssociate({ firstName: 'Mia', lastName: 'Boss' });
    const [ana, ben, stranger] = await Promise.all([
      createAssociate({ firstName: 'Ana', lastName: 'Reyes' }),
      createAssociate({ firstName: 'Ben', lastName: 'Cole' }),
      createAssociate({ firstName: 'Zed', lastName: 'Else' }),
    ]);
    await prisma.associate.updateMany({ where: { id: { in: [ana.id, ben.id] } }, data: { managerId: boss.id } });
    const now = new Date();
    const weekStart = startOfWeekUTC(now);
    const inAt = new Date(weekStart.getTime() + 60_000);
    const outAt = new Date(Math.min(now.getTime(), inAt.getTime() + 3 * HOUR));
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: a.client.id, clockInAt: inAt, clockOutAt: outAt, status: 'COMPLETED' } });
    await prisma.timeEntry.create({ data: { associateId: stranger.id, clientId: a.client.id, clockInAt: inAt, clockOutAt: outAt, status: 'COMPLETED' } });
    const ahead = new Date(now.getTime() + HOUR);
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY - 2 * HOUR);
    const canSchedule = ahead.getTime() + 2 * HOUR < weekEnd.getTime();
    if (canSchedule) await shift(a.client.id, a.site.id, ahead, 2, { associateId: ana.id });

    const { user } = await createUser({ role: 'MANAGER', associateId: boss.id });
    const res = await (await loginAs(agent(), user.email)).get('/attendance/team-hours');
    expect(res.status).toBe(200);
    expect(res.body.thresholdHours).toBe(40);
    expect(res.body.weekStart).toBe(dateKeyInZone(weekStart, TZ));
    expect(res.body.people.map((p: { name: string }) => p.name)).toEqual(['Ana Reyes', 'Ben Cole']);
    const worked = Math.round(((outAt.getTime() - inAt.getTime()) / HOUR) * 10) / 10;
    expect(res.body.people[0]).toMatchObject({ workedHours: worked, scheduledHours: canSchedule ? 2 : 0, onClock: false });
    expect(res.body.people[1]).toMatchObject({ workedHours: 0, projectedHours: 0 });

    // No associate link: an empty team, not an error.
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    expect((await (await loginAs(agent(), hrUser.email)).get('/attendance/team-hours')).body.people).toEqual([]);
  });
});
