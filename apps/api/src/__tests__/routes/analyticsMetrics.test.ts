import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { METRICS, paidMinutesForRange } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { companyWorkweek, dateKeyInZone, startOfWeekUTC } from '../../lib/timeAnomalies.js';
import { paidHoursByWeek, weekStartsEndingWith } from '../../lib/paidHours.js';
import { tenantIdForWrite } from '../../lib/tenant.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The metric dictionary on Analytics (deep audit 2026-10-29): each number
 * here is the shared definition (packages/shared metrics.ts), asserted
 * against the seed — LEAD-1 open shifts, LEAD-21 hours this week, CODE-19
 * onboarding aggregates with no silent cap.
 */

const HOUR = 60 * 60 * 1000;

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

describe('Open shifts (METRICS.openShifts)', () => {
  it('counts published shifts with no one assigned — never an assigned one, an ended one or a draft', async () => {
    expect(METRICS.openShifts.definition).toMatch(/no one assigned/);
    const client = await createClient();
    const worker = await createAssociate();
    const base = { clientId: client.id, position: 'Cashier' };
    const tomorrow = Date.now() + 24 * HOUR;
    await prisma.shift.createMany({
      data: [
        // Counted: open, ahead.
        { ...base, startsAt: new Date(tomorrow), endsAt: new Date(tomorrow + 8 * HOUR), status: 'OPEN' },
        // Counted: open and under way (not over yet).
        { ...base, startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + 3 * HOUR), status: 'OPEN' },
        // Not counted: assigned (the old count read these — 276 against 1).
        { ...base, startsAt: new Date(tomorrow), endsAt: new Date(tomorrow + 8 * HOUR), status: 'ASSIGNED', assignedAssociateId: worker.id },
        { ...base, startsAt: new Date(tomorrow + 24 * HOUR), endsAt: new Date(tomorrow + 32 * HOUR), status: 'ASSIGNED', assignedAssociateId: worker.id },
        // Not counted: a draft, a cancelled one, one already over, one past the window.
        { ...base, startsAt: new Date(tomorrow), endsAt: new Date(tomorrow + 8 * HOUR), status: 'DRAFT' },
        { ...base, startsAt: new Date(tomorrow), endsAt: new Date(tomorrow + 8 * HOUR), status: 'CANCELLED' },
        { ...base, startsAt: new Date(Date.now() - 10 * HOUR), endsAt: new Date(Date.now() - 2 * HOUR), status: 'OPEN' },
        { ...base, startsAt: new Date(Date.now() + 40 * 24 * HOUR), endsAt: new Date(Date.now() + 40 * 24 * HOUR + 8 * HOUR), status: 'OPEN' },
      ],
    });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const res = await (await loginAs(ops.email)).get('/analytics/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.openShiftsNext30d).toBe(2);
  });
});

describe('Hours this week and scheduled hours (METRICS.hoursThisWeek / scheduledHours)', () => {
  it('reads the company week (Saturday, company zone): paid hours so far and the week’s scheduled hours at paid minutes', async () => {
    const now = pinMidweekNoon();
    const { timezone } = companyWorkweek();
    const weekStart = startOfWeekUTC(now);
    const client = await createClient();
    const a = await createAssociate();
    // Two punches this week (one with a 30-minute meal), one last week, one rejected.
    const at = (h: number) => new Date(weekStart.getTime() + h * HOUR);
    await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, clockInAt: at(13), clockOutAt: at(21), status: 'APPROVED' } });
    await prisma.timeEntry.create({
      data: {
        associateId: a.id,
        clientId: client.id,
        clockInAt: at(37),
        clockOutAt: at(46),
        status: 'COMPLETED',
        breaks: { create: [{ type: 'MEAL', startedAt: at(41), endedAt: at(41.5) }] },
      },
    });
    await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, clockInAt: at(-30), clockOutAt: at(-22), status: 'APPROVED' } });
    await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, clockInAt: at(50), clockOutAt: at(54), status: 'REJECTED' } });
    // Shifts: 8h (an hour's meal out → 7), 5h (no meal), cancelled (out), next week (out), last week (out).
    const shifts = [
      { startsAt: at(60), endsAt: at(68), status: 'ASSIGNED' as const, assignedAssociateId: a.id },
      { startsAt: at(80), endsAt: at(85), status: 'OPEN' as const },
      { startsAt: at(90), endsAt: at(98), status: 'CANCELLED' as const },
      { startsAt: at(7 * 24 + 2), endsAt: at(7 * 24 + 10), status: 'OPEN' as const },
      { startsAt: at(-20), endsAt: at(-12), status: 'OPEN' as const },
    ];
    await prisma.shift.createMany({ data: shifts.map((s) => ({ ...s, clientId: client.id, position: 'Cashier' })) });

    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const res = await (await loginAs(ops.email)).get('/analytics/dashboard');
    expect(res.status).toBe(200);
    const week = res.body.week;
    // The company week's first and last days, on the company calendar.
    expect(week.start).toBe(dateKeyInZone(weekStart, timezone));
    expect(new Date(`${week.start}T12:00:00Z`).getUTCDay()).toBe(6);
    expect(new Date(`${week.end}T12:00:00Z`).getUTCDay()).toBe(5);
    expect(week.timezone).toBe(timezone);
    // Paid hours: 8 + 8.5 — the trend's last bucket and lib/paidHours, one number.
    expect(week.paidHours).toBe(16.5);
    expect(week.paidHours).toBe(res.body.trends.hoursWorked.series.at(-1));
    const [lib] = await paidHoursByWeek(prisma, { tenantId: tenantIdForWrite(), weekStarts: weekStartsEndingWith(now, 1), end: now });
    expect(week.paidHours).toBe(lib);
    // Scheduled hours: the shared paidMinutesForRange over this week's non-cancelled shifts.
    const expected = shifts
      .filter((s) => s.status !== 'CANCELLED' && s.startsAt >= weekStart && s.startsAt.getTime() < weekStart.getTime() + 7 * 24 * HOUR)
      .reduce((n, s) => n + paidMinutesForRange(s.startsAt, s.endsAt), 0) / 60;
    expect(expected).toBe(12);
    expect(week.scheduledHours).toBe(expected);
  });
});

describe('Onboarding analytics aggregate every application (CODE-19)', () => {
  it('counts past the old 500-row read: totals, medians and months cover all of them', async () => {
    const client = await createClient();
    const a = await createAssociate();
    const now = Date.now();
    const DAY = 24 * HOUR;
    // 540 invites 10 days ago: 300 finished in 2 days, 240 in 4 days, plus 60 not finished.
    const rows = [
      ...Array.from({ length: 300 }, () => ({ invitedAt: new Date(now - 10 * DAY), submittedAt: new Date(now - 8 * DAY) })),
      ...Array.from({ length: 240 }, () => ({ invitedAt: new Date(now - 10 * DAY), submittedAt: new Date(now - 6 * DAY) })),
      ...Array.from({ length: 60 }, () => ({ invitedAt: new Date(now - 10 * DAY), submittedAt: null })),
    ];
    await prisma.application.createMany({
      data: rows.map((r) => ({ associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD' as const, status: r.submittedAt ? ('SUBMITTED' as const) : ('DRAFT' as const), ...r })),
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await (await loginAs(hr.email)).get('/analytics/onboarding');
    expect(res.status).toBe(200);
    expect(res.body.completion.sample).toBe(540);
    // Median of 300 × 2 days and 240 × 4 days is 2; the 90th percentile is 4.
    expect(res.body.completion.medianDays).toBeCloseTo(2, 5);
    expect(res.body.completion.p90Days).toBeCloseTo(4, 5);
    const track = res.body.byTrack.find((t: { track: string }) => t.track === 'STANDARD');
    expect(track).toMatchObject({ count: 600, completed: 540 });
    expect(res.body.byClient).toEqual([expect.objectContaining({ clientId: client.id, count: 600, completed: 540 })]);
    const invited = res.body.monthly.reduce((n: number, m: { invited: number }) => n + m.invited, 0);
    const completed = res.body.monthly.reduce((n: number, m: { completed: number }) => n + m.completed, 0);
    expect(invited).toBe(600);
    expect(completed).toBe(540);
    expect(res.body.monthly).toHaveLength(6);
    expect(res.body.byStatus).toMatchObject({ SUBMITTED: 540, DRAFT: 60 });
  });

  it('a client-bound caller reads only their client', async () => {
    const mine = await createClient();
    const other = await createClient();
    const a = await createAssociate();
    await prisma.application.createMany({
      data: [
        { associateId: a.id, clientId: mine.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED', invitedAt: new Date(Date.now() - 5 * 24 * HOUR), submittedAt: new Date(Date.now() - 4 * 24 * HOUR) },
        { associateId: a.id, clientId: other.id, onboardingTrack: 'J1', status: 'SUBMITTED', invitedAt: new Date(Date.now() - 5 * 24 * HOUR), submittedAt: new Date(Date.now() - 3 * 24 * HOUR) },
      ],
    });
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: mine.id });
    const res = await (await loginAs(portal.email)).get('/analytics/onboarding');
    expect(res.status).toBe(200);
    expect(res.body.completion.sample).toBe(1);
    expect(res.body.byTrack.map((t: { track: string }) => t.track)).toEqual(['STANDARD']);
    expect(res.body.byClient.map((c: { clientId: string }) => c.clientId)).toEqual([mine.id]);
  });
});

describe('Store trends read one week per screen (LEAD-23)', () => {
  it('for one client, the weeks are that client’s own (its weekStartsOn); company-wide, the company week', async () => {
    const client = await createClient();
    await prisma.client.update({ where: { id: client.id }, data: { weekStartsOn: 0 } });
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const a = await createAssociate();
    const start = new Date(Date.now() - 9 * 24 * HOUR);
    start.setUTCHours(15, 0, 0, 0);
    await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, locationId: site.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 8 * HOUR), status: 'APPROVED' } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const agentFor = await loginAs(ops.email);
    const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

    const mine = await agentFor.get(`/scheduling/store-trends?clientId=${client.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.weekStartsOn).toBe(0);
    const weeks = mine.body.stores[0].weeks as Array<{ start: string; hours: number }>;
    expect(weeks).toHaveLength(4);
    for (const w of weeks) expect(weekday(w.start)).toBe(0);
    expect(weeks.reduce((n, w) => n + w.hours, 0)).toBeCloseTo(8, 5);

    const company = await agentFor.get('/scheduling/store-trends');
    expect(company.body.weekStartsOn).toBe(companyWorkweek().weekStartsOn);
    for (const w of company.body.stores[0].weeks as Array<{ start: string }>) expect(weekday(w.start)).toBe(companyWorkweek().weekStartsOn);
  });
});
