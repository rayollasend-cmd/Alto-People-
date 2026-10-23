import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { addWeeks, forecastSite } from '../../lib/forecast/model.js';
import { startOfWeekUTC } from '../../lib/timeAnomalies.js';
import { localToday } from '../../lib/billing.js';

/**
 * F500 G4 (the insights pages): the numbers the fix-up added or changed,
 * each seeded and asserted exactly.
 */

const app = () => createApp();
const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function store(name: string) {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  return { client, site };
}

async function placed(first: string, siteId: string) {
  const a = await createAssociate({ firstName: first, lastName: 'Test' });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: new Date(Date.now() - 30 * DAY) } });
  return a;
}

describe('GET /people-analytics — one row per site, closed sites folded together', () => {
  it('labels active sites "Client · Site" and folds every inactive site into one "Inactive sites" row', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { site } = await store('Coastal');
    await prisma.site.update({ where: { id: site.id }, data: { name: 'Front Beach' } });
    await placed('Ana', site.id);
    await placed('Ben', site.id);
    // Two closed sites with the same old name, one person hired into each.
    const old1 = await prisma.site.create({ data: { name: 'The Grand Hotel', isActive: false } });
    const old2 = await prisma.site.create({ data: { name: 'The Grand Hotel', isActive: false } });
    await placed('Cal', old1.id);
    await placed('Dee', old2.id);
    // A closed site nobody was hired into never appears.
    await prisma.site.create({ data: { name: 'Empty Lot', isActive: false } });

    const a = await loginAs(hr.email);
    const res = await a.get('/people-analytics?months=3');
    expect(res.status).toBe(200);

    const bySite = res.body.turnover.bySite as Array<{ key: string; label: string; headcount: number; inactive?: boolean; siteCount?: number }>;
    expect(bySite).toHaveLength(2);
    expect(bySite.find((r) => r.key === site.id)).toMatchObject({ label: 'Coastal · Front Beach', headcount: 2 });
    expect(bySite.find((r) => r.key === 'inactive')).toMatchObject({ label: 'Inactive sites', headcount: 2, inactive: true, siteCount: 2 });

    const grid = res.body.turnoverGrid.rows as Array<{ storeId: string; hires: number; inactive: boolean; siteCount: number }>;
    expect(grid.map((r) => r.storeId)).toEqual([site.id, 'inactive']);
    expect(grid[1]).toMatchObject({ inactive: true, siteCount: 2, hires: 2 });

    // The trend by store draws only the stores people work at today.
    expect((res.body.headcountByStore as Array<{ storeId: string }>).map((s) => s.storeId)).toEqual([site.id]);
  });
});

describe('the forecast — a falling site settles, a new site starts where its history does', () => {
  it('caps the trend\'s total pull at 20% of the recent level: ~99 h falling ~10 h a week settles at 79 h, never 0', () => {
    const anchor = '2026-10-10';
    const series = new Map<string, number>();
    [120, 120, 120, 120, 100, 90, 70, 50].forEach((h, i) => series.set(addWeeks(anchor, i - 8), h));
    const points = forecastSite(series, { anchor, horizonWeeks: 26, weights: { lastYearWeight: 0, bandLow: 0, bandHigh: 0 } });
    // recent mean 790 ÷ 8 = 98.75; trend (77.5 − 120) ÷ 4 = −10.625 a week.
    expect(points[0]!.drivers.recentMean).toBe(98.8);
    expect(points[0]!.drivers.trendPerWeek).toBe(-10.6);
    expect(points[0]!.p50).toBe(88.1);
    // From week 2 on the pull is capped at 20% of 98.75 = 19.75 h: 79 h × the week's holiday factor, never lower.
    for (const p of points.slice(1)) {
      expect(p.p50).toBe(Math.round(79 * p.drivers.holidayFactor * 10) / 10);
    }
  });

  it('reads back only the weeks since the site\'s first verified hours, so nothing before it is drawn as a zero', async () => {
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER', email: 'wfm@example.com' });
    const { site } = await store('Coastal');
    const assoc = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    // Nine completed weeks of 80 hours (ten eight-hour punches), nothing before.
    const thisWeek = startOfWeekUTC(new Date());
    const rows: Array<{ associateId: string; locationId: string; clockInAt: Date; clockOutAt: Date; status: 'APPROVED' }> = [];
    for (let w = 1; w <= 9; w++) {
      const weekStart = new Date(thisWeek.getTime() - w * 7 * DAY);
      for (let p = 0; p < 10; p++) {
        const clockInAt = new Date(weekStart.getTime() + (p % 5) * DAY + 14 * 3_600_000 + Math.floor(p / 5) * 9 * 3_600_000);
        rows.push({ associateId: assoc.id, locationId: site.id, clockInAt, clockOutAt: new Date(clockInAt.getTime() + 8 * 3_600_000), status: 'APPROVED' });
      }
    }
    await prisma.timeEntry.createMany({ data: rows });
    const a = await loginAs(wfm.email);
    expect((await a.post('/forecast/runs').send({})).status).toBe(201);
    const sites = await a.get('/forecast/sites');
    expect(sites.body.sites[0].historyWeeks).toBe(9);
    const detail = await a.get(`/forecast/sites/${site.id}`);
    const past = (detail.body.weeks as Array<{ actualHours: number | null }>).filter((w) => w.actualHours !== null);
    const future = (detail.body.weeks as Array<{ actualHours: number | null; p50: number }>).filter((w) => w.actualHours === null);
    expect(past).toHaveLength(9);
    expect(past.every((w) => w.actualHours === 80)).toBe(true);
    expect(future).toHaveLength(26);
    // A steady 80 h site forecasts about 80 h every week, not a slide to zero.
    expect(Math.min(...future.map((w) => w.p50))).toBeGreaterThanOrEqual(80);
  });
});

describe('GET /call-outs — the record behind a quiet day', () => {
  it('reports 30 days with the median time to cover and repeat callers, the last 7 days for the all-clear line, and filters by site', async () => {
    const { user: ops } = await createUser({ role: 'WORKFORCE_MANAGER', email: 'wfm@example.com' });
    const { client, site: a } = await store('Coastal');
    const b = await prisma.site.create({ data: { clientId: client.id, name: 'Back Bay' } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Ortiz' });
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Cover' });
    const H = 3_600_000;
    const now = Date.now();
    async function calledOut(who: string, siteId: string, startsAgoH: number, noticeMin: number, coverAfterMin: number | null) {
      const startsAt = new Date(now - startsAgoH * H);
      const createdAt = new Date(startsAt.getTime() - noticeMin * 60_000);
      const shift = await prisma.shift.create({
        data: {
          clientId: client.id,
          locationId: siteId,
          position: 'Cashier',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 8 * H),
          status: 'ASSIGNED',
          assignedAssociateId: coverAfterMin === null ? who : bo.id,
          assignedAt: coverAfterMin === null ? null : new Date(createdAt.getTime() + coverAfterMin * 60_000),
        },
      });
      await prisma.callOut.create({ data: { shiftId: shift.id, associateId: who, clientId: client.id, locationId: siteId, channel: 'SMS', minutesBeforeStart: noticeMin, createdAt } });
    }
    await calledOut(ana.id, a.id, 48, 180, 30); // covered in 30 min
    await calledOut(ana.id, a.id, 72, 120, 50); // covered in 50 min
    await calledOut(ben.id, b.id, 24, 60, null); // never covered
    await calledOut(ana.id, a.id, 20 * 24, 240, 90); // 20 days ago, covered in 90 min

    const s = await loginAs(ops.email);
    const month = await s.get('/call-outs?range=30d');
    expect(month.status).toBe(200);
    expect(month.body).toMatchObject({ range: '30d', total: 4, covered: 3, uncovered: 1, medianMinutesToCover: 50 });
    expect(month.body.repeatCallers).toEqual([{ associateId: ana.id, name: 'Ana Lopez', count: 3 }]);
    expect(month.body.sites.map((x: { name: string }) => x.name)).toEqual(['Back Bay', a.name].sort((x, y) => x.localeCompare(y)));
    // The last seven days: 3 call-outs, 2 covered (67%), median of 30 and 50 minutes.
    expect(month.body.last7Days).toEqual({ total: 3, covered: 2, coveredPct: 67, medianMinutesToCover: 40 });

    // Today: nothing in range, but the week's record is still there for the all-clear line.
    const today = await s.get('/call-outs');
    expect(today.body.total).toBe(0);
    expect(today.body.last7Days.total).toBe(3);

    // One site: Back Bay's single uncovered call-out; the site list still offers both.
    const one = await s.get(`/call-outs?range=30d&siteId=${b.id}`);
    expect(one.body).toMatchObject({ total: 1, siteId: b.id, medianMinutesToCover: null, repeatCallers: [] });
    expect(one.body.sites).toHaveLength(2);
    expect(one.body.last7Days).toEqual({ total: 1, covered: 0, coveredPct: 0, medianMinutesToCover: null });
  });
});

describe('GET /reports — who owns each saved report, when it last ran, how often it goes out', () => {
  it('names the owner, counts active schedules, and records a run', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    await prisma.user.update({ where: { id: hr.id }, data: { displayName: 'Hana Reyes' } });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'fin@example.com' });
    const a = await loginAs(hr.email);
    const made = await a.post('/reports').send({ name: 'New hires', entity: 'ASSOCIATE', spec: { columns: ['firstName', 'lastName'] }, isPublic: true });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    await prisma.reportSchedule.create({ data: { reportId: id, cadence: 'WEEKLY', recipients: 'hr@example.com', nextRunAt: new Date(Date.now() + 86_400_000) } });
    await prisma.reportSchedule.create({ data: { reportId: id, cadence: 'MONTHLY', recipients: 'hr@example.com', nextRunAt: new Date(Date.now() + 86_400_000), isActive: false } });

    const before = await (await loginAs(fin.email)).get('/reports');
    const row = (before.body.reports as Array<Record<string, unknown>>).find((r) => r.id === id)!;
    expect(row).toMatchObject({ ownerName: 'Hana Reyes', mine: false, lastRunAt: null, scheduleCount: 1, cadences: ['WEEKLY'] });

    expect((await a.post(`/reports/${id}/run`).send({})).status).toBe(200);
    const after = await a.get('/reports');
    const ran = (after.body.reports as Array<{ id: string; lastRunAt: string | null; mine: boolean }>).find((r) => r.id === id)!;
    expect(ran.mine).toBe(true);
    expect(ran.lastRunAt).not.toBeNull();
    expect(Date.now() - new Date(ran.lastRunAt!).getTime()).toBeLessThan(60_000);
  });
});

describe('GET /billing — the last six months of billable counts', () => {
  it('counts each id active on at least one day of a month once, month by month, newest first', async () => {
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'fin@example.com' });
    const [y, m] = localToday().slice(0, 7).split('-').map(Number) as [number, number];
    const day = (back: number, d: number) => new Date(Date.UTC(y, m - 1 - back, d));
    const key = (back: number) => day(back, 1).toISOString().slice(0, 7);
    // Last month: a, b on the 3rd; b, c on the 4th → 3 people; one agent.
    await prisma.usageSnapshot.createMany({
      data: [
        { day: day(1, 3), type: 'PERSON', count: 2, ids: ['a', 'b'] },
        { day: day(1, 4), type: 'PERSON', count: 2, ids: ['b', 'c'] },
        { day: day(1, 4), type: 'AGENT', count: 1, ids: ['g1'] },
        // Three months back: one person.
        { day: day(3, 10), type: 'PERSON', count: 1, ids: ['z'] },
        // Seven months back: outside the six.
        { day: day(7, 10), type: 'PERSON', count: 1, ids: ['q'] },
      ],
    });
    const res = await (await loginAs(fin.email)).get('/billing');
    expect(res.status).toBe(200);
    const h = res.body.history as Array<{ month: string; daysCounted: number; counts: Record<string, number> }>;
    expect(h.map((x) => x.month)).toEqual([1, 2, 3, 4, 5, 6].map(key));
    expect(h[0]).toEqual({ month: key(1), daysCounted: 2, counts: { PERSON: 3, AGENT: 1, ROBOT: 0 } });
    expect(h[1]!.counts).toEqual({ PERSON: 0, AGENT: 0, ROBOT: 0 });
    expect(h[2]).toMatchObject({ daysCounted: 1, counts: { PERSON: 1 } });
  });
});

describe('GET /tasks/policy — which sites carry their own policy', () => {
  it('lists the sites with an override so the scope picker can mark them', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { site } = await store('Coastal');
    const a = await loginAs(hr.email);
    expect((await a.get('/tasks/policy')).body.overrideLocationIds).toEqual([]);
    expect((await a.put(`/tasks/policy?locationId=${site.id}`).send({ handoffSeconds: 60 })).status).toBe(200);
    // The tenant default is not an override.
    expect((await a.put('/tasks/policy').send({ handoffSeconds: 45 })).status).toBe(200);
    const after = await a.get('/tasks/policy');
    expect(after.body.overrideLocationIds).toEqual([site.id]);
    expect(after.body.handoffSeconds).toBe(45);
  });
});
