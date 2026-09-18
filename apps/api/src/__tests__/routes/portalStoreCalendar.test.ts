import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { buildPortalReport, portalScopeFor } from '../../lib/portalDayReport.js';
import { storeSnapshot } from '../../lib/storeSnapshot.js';
import { storeCalendar } from '../../lib/portalMetrics.js';

/**
 * The portal reads a store on the store's own calendar. On the org's
 * (Eastern) calendar a 10 PM Pacific Friday shift is Saturday — the next
 * week — so the store manager's schedule dropped it from Friday, the
 * history counted it on the wrong day, and the region's "today by hour"
 * started at 9 PM the night before.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
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

const PT = 'America/Los_Angeles';
// Friday Oct 9, 2026, 10 PM PDT = Saturday Oct 10, 05:00 UTC (1 AM Eastern).
const FRI_10PM = new Date('2026-10-10T05:00:00Z');

async function pacificStore() {
  const client = await createClient('Front Beach');
  const store = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.location.update({ where: { id: store.id }, data: { timezone: PT } });
  const shift = await prisma.shift.create({
    data: {
      clientId: client.id,
      locationId: store.id,
      position: 'Porter',
      startsAt: FRI_10PM,
      endsAt: new Date(FRI_10PM.getTime() + 8 * 3_600_000),
      status: 'OPEN',
      publishedAt: new Date('2026-09-01'),
    },
  });
  const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  await prisma.user.update({ where: { id: user.id }, data: { locationId: store.id } });
  return { client, store, shift, manager: await loginAs(user.email) };
}

describe("the portal reads a store on the store's calendar", () => {
  it('the schedule puts a 10 PM Friday shift on Friday of that week', async () => {
    const { shift, manager } = await pacificStore();
    const res = await manager.get('/client-portal/schedule?week=2026-10-09');
    expect(res.status).toBe(200);
    expect(res.body.week).toEqual({ start: '2026-10-03', end: '2026-10-09' });
    const friday = (res.body.days as Array<{ date: string; shifts: Array<{ shiftId: string }> }>).find(
      (d) => d.date === '2026-10-09',
    )!;
    expect(friday.shifts.map((s) => s.shiftId)).toEqual([shift.id]);
  });

  it('history counts it on Friday, not Saturday', async () => {
    const { manager } = await pacificStore();
    const res = await manager.get('/client-portal/history?from=2026-10-09&to=2026-10-10');
    expect(res.status).toBe(200);
    const byDay = Object.fromEntries(
      (res.body.days as Array<{ date: string; published: number }>).map((d) => [d.date, d.published]),
    );
    expect(byDay).toEqual({ '2026-10-09': 1, '2026-10-10': 0 });
  });

  it("the service report's Friday carries it, drawn at the store's 10 PM", async () => {
    const { client, store } = await pacificStore();
    const scope = await portalScopeFor(client.id, store.id);
    const data = await buildPortalReport(scope!, '2026-10-09', '2026-10-10', 'Alto', new Date('2026-10-01T12:00:00Z'));
    expect(data.timezone).toBe(PT);
    const [friday, saturday] = data.days;
    expect(friday!.summary.open).toBe(1);
    expect(friday!.waves.map((w) => w.timeRange)).toEqual(['10:00 PM – 6:00 AM']);
    // Saturday only sees the crew finishing, never a new unfilled slot.
    expect(saturday!.dashboard.week.days.find((d) => d.date === '2026-10-10')!.open).toBe(0);
  });

  it("the region's today-by-hour starts at the store's midnight", async () => {
    const { client, store } = await pacificStore();
    // Friday 1 PM Pacific.
    const snap = await storeSnapshot(
      { id: store.id, name: store.name, timezone: PT, clientId: client.id, clientName: 'Front Beach' },
      new Date('2026-10-09T20:00:00Z'),
    );
    expect(snap.today.open).toBe(1);
    const openHours = snap.hours.filter((h) => h.open > 0).map((h) => h.hour);
    expect(openHours).toEqual([22, 23]);
  });
});

describe("the supervisor's fill rate is the store manager's", () => {
  it('reads the store workweek (Sat→Fri, store clock) — the edges land where the portal puts them', async () => {
    const { client, store, manager } = await pacificStore();
    await prisma.shift.deleteMany({ where: { clientId: client.id } });
    const cal = storeCalendar(PT);
    const now = new Date();
    const ws = cal.weekStart(now);
    const we = cal.weekEnd(now);
    const H = 3_600_000;
    const mk = (startsAt: Date, status: 'OPEN' | 'ASSIGNED') =>
      prisma.shift.create({
        data: {
          clientId: client.id,
          locationId: store.id,
          position: 'Porter',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 8 * H),
          status,
          publishedAt: new Date('2026-01-01'),
        },
      });
    // Last Friday 10 PM Pacific (Saturday 1 AM Eastern): LAST week, open.
    await mk(new Date(ws.getTime() - 2 * H), 'OPEN');
    // This week: Saturday 1 AM, Sunday 6 AM, and Friday 11 PM Pacific
    // (Saturday 2 AM Eastern) — all filled.
    await mk(new Date(ws.getTime() + H), 'ASSIGNED');
    await mk(new Date(ws.getTime() + 30 * H), 'ASSIGNED');
    await mk(new Date(we.getTime() - H), 'ASSIGNED');

    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const sup = await loginAs(user.email);
    const thisWeek = await sup.get('/scheduling/kpis?week=this');
    expect(thisWeek.status).toBe(200);
    expect(thisWeek.body).toMatchObject({
      from: ws.toISOString(),
      to: we.toISOString(),
      assignedShifts: 3,
      openShifts: 0,
      fillRatePercent: 100,
    });
    const lastWeek = await sup.get('/scheduling/kpis?week=last');
    expect(lastWeek.body).toMatchObject({ assignedShifts: 0, openShifts: 1, fillRatePercent: 0 });

    // The store manager's home grades the same week the same way.
    const portal = await manager.get('/client-portal/overview');
    expect(portal.body.week).toMatchObject({ filled: 3, open: 0, fillRatePct: 100 });

    expect((await sup.get('/scheduling/kpis?week=next')).status).toBe(400);
  });
});

describe("the schedule grid's strip counts the days on screen", () => {
  it("cuts the visible days on the store's calendar — a 10 PM Friday shift is in its Friday's week", async () => {
    const { client, shift } = await pacificStore();
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const sup = await loginAs(user.email);
    // The week of Sat Oct 3 – Fri Oct 9 holds the Friday 10 PM Pacific shift…
    const week = await sup.get('/scheduling/kpis?fromDay=2026-10-03&toDay=2026-10-09');
    expect(week.status).toBe(200);
    expect(week.body).toMatchObject({
      from: '2026-10-03T07:00:00.000Z',
      to: '2026-10-10T07:00:00.000Z',
      openShifts: 1,
    });
    // …and the next week doesn't, though it starts Saturday 1 AM Eastern.
    const next = await sup.get('/scheduling/kpis?fromDay=2026-10-10&toDay=2026-10-16');
    expect(next.body.openShifts).toBe(0);
    expect(shift.startsAt.toISOString()).toBe('2026-10-10T05:00:00.000Z');

    expect((await sup.get('/scheduling/kpis?fromDay=2026-10-09&toDay=2026-10-03')).status).toBe(400);
    expect((await sup.get('/scheduling/kpis?fromDay=2026-10-03&toDay=2027-01-03')).status).toBe(400);
    expect((await sup.get('/scheduling/kpis?fromDay=Oct-3')).status).toBe(400);
  });
});
