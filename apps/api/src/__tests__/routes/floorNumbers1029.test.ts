import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { teamNumbers } from '../../lib/teamNumbers.js';
import { dateKeyInZone, endOfWeekUTC, startOfWeekUTC, utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';
import type { SessionUser } from '../../types/express.js';

/**
 * Running the floor — the numbers a supervisor and a manager read must be
 * the company's (or the store's) day and week, and agree with the page
 * they open (deep audit 2026-10-29: FLOOR-4, FLOOR-5, FLOOR-8, FLOOR-16,
 * FLOOR-23, CODE-14, CODE-15, CODE-29).
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const ET = 'America/New_York';

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Pin the clock to 01:00 UTC — the evening before in Eastern time (9 PM EDT /
 * 8 PM EST) and 6 PM in Los Angeles: the hours where a UTC "today" is already
 * tomorrow. Returns the company's day and the UTC day.
 */
function pinPacificEvening(): { now: Date; companyKey: string; utcKey: string } {
  const real = new Date();
  const now = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), 1, 0));
  if (now.getTime() > real.getTime()) now.setUTCDate(now.getUTCDate() - 1);
  vi.useFakeTimers({ toFake: ['Date'], now });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return { now, companyKey: dateKeyInZone(now, ET), utcKey: now.toISOString().slice(0, 10) };
}

const keyPlus = (key: string, days: number) => new Date(Date.parse(`${key}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const dateCol = (key: string) => new Date(`${key}T00:00:00Z`);

async function store(name = 'Front Beach 218') {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  return { client, site };
}

async function managerWithTeam() {
  const boss = await createAssociate({ firstName: 'Priya', lastName: 'Shah' });
  const [ana, ben, cy] = await Promise.all([
    createAssociate({ firstName: 'Ana', lastName: 'Reyes' }),
    createAssociate({ firstName: 'Ben', lastName: 'Cole' }),
    createAssociate({ firstName: 'Cy', lastName: 'Park' }),
  ]);
  await prisma.associate.updateMany({ where: { id: { in: [ana.id, ben.id, cy.id] } }, data: { managerId: boss.id } });
  const { user } = await createUser({ role: 'MANAGER', associateId: boss.id });
  return { boss, ana, ben, cy, user };
}

describe('the manager’s Home cuts "today" on the company’s day (FLOOR-5)', () => {
  it('a Pacific evening lists tonight’s team, not tomorrow’s shifts, birthdays and leave', async () => {
    const { companyKey, utcKey } = pinPacificEvening();
    expect(companyKey).not.toBe(utcKey);
    const { client, site } = await store();
    const t = await managerWithTeam();
    const companyMidnight = utcInstantOfLocalMidnight(companyKey, ET);
    const today = await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt: new Date(companyMidnight.getTime() + 12 * HOUR), endsAt: new Date(companyMidnight.getTime() + 20 * HOUR), status: 'ASSIGNED', assignedAssociateId: t.ana.id, publishedAt: new Date() },
    });
    // 10 AM tomorrow in Eastern time — the UTC day's.
    const tomorrow = await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt: new Date(companyMidnight.getTime() + 34 * HOUR), endsAt: new Date(companyMidnight.getTime() + 42 * HOUR), status: 'ASSIGNED', assignedAssociateId: t.ben.id, publishedAt: new Date() },
    });
    await prisma.associate.update({ where: { id: t.ana.id }, data: { dob: dateCol(`1990-${companyKey.slice(5)}`) } });
    await prisma.associate.update({ where: { id: t.ben.id }, data: { dob: dateCol(`1991-${utcKey.slice(5)}`) } });
    // Cy's leave ends today (a DATE column).
    await prisma.timeOffRequest.create({ data: { associateId: t.cy.id, category: 'PTO', startDate: dateCol(keyPlus(companyKey, -2)), endDate: dateCol(companyKey), requestedMinutes: 1440, status: 'APPROVED' } });

    const a = await loginAs(agent(), t.user.email);
    const res = await a.get('/team/home');
    expect(res.status).toBe(200);
    expect(res.body.today.date).toBe(companyKey);
    expect(res.body.today.shifts.map((s: { id: string }) => s.id)).toEqual([today.id]);
    expect(res.body.today.shifts.map((s: { id: string }) => s.id)).not.toContain(tomorrow.id);
    expect(res.body.today.celebrations.map((c: { associateId: string }) => c.associateId)).toEqual([t.ana.id]);
    expect(res.body.today.out.map((o: { associateId: string }) => o.associateId)).toEqual([t.cy.id]);
  });
});

describe('My team says a flagged timesheet in words (FLOOR-16)', () => {
  it('"Forgot clock-out", never "flagged: forgot_clockout" — and marks it so a batch approve leaves it', async () => {
    const { client } = await store();
    const t = await managerWithTeam();
    await prisma.timeEntry.create({ data: { associateId: t.ana.id, clientId: client.id, clockInAt: new Date(Date.now() - 30 * HOUR), clockOutAt: new Date(Date.now() - 20 * HOUR), status: 'COMPLETED', anomalies: ['FORGOT_CLOCKOUT'] } });
    await prisma.timeEntry.create({ data: { associateId: t.ben.id, clientId: client.id, clockInAt: new Date(Date.now() - 30 * HOUR), clockOutAt: new Date(Date.now() - 22 * HOUR), status: 'COMPLETED' } });
    const a = await loginAs(agent(), t.user.email);
    const res = await a.get('/team/inbox');
    expect(res.status).toBe(200);
    const ana = res.body.items.find((i: { associateId: string }) => i.associateId === t.ana.id);
    const ben = res.body.items.find((i: { associateId: string }) => i.associateId === t.ben.id);
    expect(ana.summary).toMatch(/· Forgot clock-out$/);
    expect(JSON.stringify(res.body)).not.toMatch(/forgot_clockout|FORGOT_CLOCKOUT|flagged:/);
    expect(ana.flagged).toBe(true);
    expect(ben.flagged).toBe(false);
  });
});

describe('overtime risk is one definition: worked + still scheduled reaches 36 h (FLOOR-23)', () => {
  it('counts 37 h as at risk on My team, as Time & attendance does', async () => {
    const now = pinMidweekNoon();
    const { client, site } = await store();
    const t = await managerWithTeam();
    const weekStart = startOfWeekUTC(now);
    // Ana: 37 h worked across four days this week (no meal breaks recorded, short shifts).
    for (let d = 0; d < 4; d += 1) {
      const start = new Date(weekStart.getTime() + d * DAY + 8 * HOUR);
      await prisma.timeEntry.create({ data: { associateId: t.ana.id, clientId: client.id, locationId: site.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 9.25 * HOUR), status: 'APPROVED' } });
    }
    const n = await teamNumbers({ ...t.user, associateId: t.boss.id } as unknown as SessionUser, now);
    expect(n.people.get(t.ana.id)?.projectedHours).toBeGreaterThanOrEqual(36);
    expect(n.people.get(t.ana.id)?.projectedHours).toBeLessThan(40);
    expect(n.overtimeRisk).toBe(1);
    expect(n.overtimeRiskHours).toBe(36);
    expect(n.overtimeThresholdHours).toBe(40);
  });
});

describe('scheduling: the company week, one person’s shifts, the contract by hour', () => {
  it('the KPI strip’s default window is the company workweek, Saturday → Saturday on the company clock (CODE-15)', async () => {
    const { now } = pinPacificEvening();
    const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(agent(), user.email);
    const res = await a.get('/scheduling/kpis');
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(startOfWeekUTC(now).toISOString());
    expect(res.body.to).toBe(endOfWeekUTC(now).toISOString());
    expect(new Date(res.body.from).getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('?associateId lists one person’s shifts, inside the caller’s scope (CODE-29)', async () => {
    const { client, site } = await store();
    const other = await store('Target 9');
    const [ana, ben] = await Promise.all([createAssociate({ firstName: 'Ana' }), createAssociate({ firstName: 'Ben' })]);
    const mk = (clientId: string, locationId: string, associateId: string, h: number) =>
      prisma.shift.create({ data: { clientId, locationId, position: 'Cashier', startsAt: new Date(Date.now() + h * HOUR), endsAt: new Date(Date.now() + (h + 8) * HOUR), status: 'ASSIGNED', assignedAssociateId: associateId, publishedAt: new Date() } });
    const anaShift = await mk(client.id, site.id, ana.id, 20);
    await mk(client.id, site.id, ben.id, 20);
    const anaElsewhere = await mk(other.client.id, other.site.id, ana.id, 30);
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const a = await loginAs(agent(), user.email);
    const res = await a.get(`/scheduling/shifts?status=ASSIGNED&associateId=${ana.id}`);
    expect(res.status).toBe(200);
    const ids = res.body.shifts.map((s: { id: string }) => s.id);
    // Only Ana's — and only at the supervisor's client, never the other one's.
    expect(ids).toEqual([anaShift.id]);
    expect(ids).not.toContain(anaElsewhere.id);
    expect((await a.get('/scheduling/shifts?associateId=nope')).status).toBe(400);
  });

  it('GET /scheduling/contract: each window with its count, and the contract hour by hour on the store’s clock (FLOOR-4)', async () => {
    const { companyKey } = pinPacificEvening();
    const { client, site } = await store();
    const second = await prisma.site.create({ data: { name: 'Thomas Drive', clientId: client.id, timezone: ET } });
    await prisma.site.update({ where: { id: site.id }, data: { timezone: ET } });
    const other = await store('Target 9');
    const from = dateCol('2024-01-01');
    await prisma.staffingTarget.createMany({
      data: [
        { locationId: site.id, label: 'Overnight', startMinute: 22 * 60, endMinute: 6 * 60, targetCount: 2, effectiveFrom: from },
        { locationId: site.id, label: 'Morning', startMinute: 6 * 60, endMinute: 14 * 60, targetCount: 3, effectiveFrom: from },
        { locationId: second.id, label: 'Morning', startMinute: 6 * 60, endMinute: 14 * 60, targetCount: 8, effectiveFrom: from },
        { locationId: other.site.id, label: 'Morning', startMinute: 6 * 60, endMinute: 14 * 60, targetCount: 50, effectiveFrom: from },
      ],
    });
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const a = await loginAs(agent(), user.email);
    // The clamp wins: naming another client changes nothing.
    const res = await a.get(`/scheduling/contract?clientId=${other.client.id}`);
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(companyKey);
    expect(res.body.timezone).toBe(ET);
    expect(res.body.windows).toHaveLength(3);
    expect(res.body.windows.every((w: { locationId: string }) => w.locationId !== other.site.id)).toBe(true);
    const at = (h: number) => res.body.hours[h].target;
    expect(res.body.hours.length).toBeGreaterThanOrEqual(23);
    expect(at(1)).toBe(2); // overnight
    expect(at(6)).toBe(11); // 3 + 8, never the other client's 50
    expect(at(15)).toBeNull(); // no contract set
    expect(at(23)).toBe(2);

    // An office account must name the client; a store-bound one sees its store only.
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const o = await loginAs(agent(), ops.email);
    expect((await o.get('/scheduling/contract')).status).toBe(400);
    const { user: storeOps } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: storeOps.id }, data: { scopeSiteIds: [second.id] } });
    const o2 = await loginAs(agent(), storeOps.email);
    const narrowed = await o2.get(`/scheduling/contract?clientId=${client.id}`);
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.windows.map((w: { locationId: string }) => w.locationId)).toEqual([second.id]);
    expect(narrowed.body.hours[6].target).toBe(8);
  });
});

describe('the Inbox agrees with the page it opens', () => {
  it('"Tasks needing a person" opens the board’s every-day view of exactly those tasks (FLOOR-8)', async () => {
    const { client, site } = await store();
    await prisma.workTask.create({
      data: { type: 'Unload the afternoon produce truck', locationId: site.id, windowStart: new Date(Date.now() - 4 * DAY), windowEnd: new Date(Date.now() - 4 * DAY + 2 * HOUR), capability: 'unloading', estimatedMinutes: 120, status: 'QUEUED' },
    });
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const a = await loginAs(agent(), user.email);
    const res = await a.get('/me/inbox');
    expect(res.status).toBe(200);
    const tasks = res.body.sources.find((s: { key: string }) => s.key === 'tasks');
    expect(tasks.count).toBe(1);
    expect(tasks.path).toBe('/tasks?needs=1');
  });

  it('the leave desk counts returns due this week from the company’s today, not UTC’s (CODE-14)', async () => {
    const { companyKey } = pinPacificEvening();
    const ana = await createAssociate({ firstName: 'Ana' });
    const ben = await createAssociate({ firstName: 'Ben' });
    // Ana is back in 7 company days (counted); Ben in 8 (not yet — UTC's today counted him).
    await prisma.leaveCase.create({ data: { associateId: ana.id, type: 'FMLA', reason: 'OWN_HEALTH', startDate: dateCol(keyPlus(companyKey, -20)), status: 'APPROVED', expectedReturnDate: dateCol(keyPlus(companyKey, 7)) } });
    await prisma.leaveCase.create({ data: { associateId: ben.id, type: 'FMLA', reason: 'OWN_HEALTH', startDate: dateCol(keyPlus(companyKey, -20)), status: 'APPROVED', expectedReturnDate: dateCol(keyPlus(companyKey, 8)) } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), user.email);
    const res = await a.get('/me/inbox');
    expect(res.status).toBe(200);
    const leave = res.body.sources.find((s: { key: string }) => s.key === 'leave-desk');
    expect(leave.count).toBe(1);
  });
});
