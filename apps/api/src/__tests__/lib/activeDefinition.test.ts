import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { activeAssociateIds, activeBreakdown, activeHeadcount, activeWindowDays, EMPLOYED_WHERE, explainActive, placements } from '../../lib/activeDefinition.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The one definition of active (Brief 1A-2).
 *
 *   Employed + placed + recent work (a clock-in in the window, or a future
 *   assigned shift). Configurable window. Scoped to a site or a client, the
 *   placement and the work are read there. Every headcount surface reads
 *   it; this file proves the rule, the scope, the window and the
 *   explanation.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
// A minute ago: the route surfaces read the real clock, so the fixture's punches must be in the past and its shifts in the future.
const NOW = new Date(Date.now() - 60_000);

async function world() {
  const coastal = await createClient('Coastal Resort');
  const siteA = await prisma.location.findFirstOrThrow({ where: { clientId: coastal.id } });
  const inland = await createClient('Inland Mart');
  const siteB = await prisma.location.findFirstOrThrow({ where: { clientId: inland.id } });
  const place = (associateId: string, locationId: string) => prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: new Date('2026-05-01') } });
  const punch = (associateId: string, daysAgo: number, locationId: string | null, clientId: string, status: 'APPROVED' | 'COMPLETED' | 'REJECTED' = 'APPROVED') =>
    prisma.timeEntry.create({ data: { associateId, clientId, locationId, clockInAt: new Date(NOW.getTime() - daysAgo * DAY), clockOutAt: new Date(NOW.getTime() - daysAgo * DAY + 8 * 3_600_000), status } });
  const shift = (associateId: string, daysAhead: number, locationId: string, clientId: string) =>
    prisma.shift.create({ data: { clientId, locationId, position: 'Associate', startsAt: new Date(NOW.getTime() + daysAhead * DAY), endsAt: new Date(NOW.getTime() + daysAhead * DAY + 8 * 3_600_000), status: 'ASSIGNED', assignedAssociateId: associateId, publishedAt: NOW } });
  return { coastal, siteA, inland, siteB, place, punch, shift };
}

describe('the rule', () => {
  it('counts the placed people who worked in the window or are scheduled, and nobody else', async () => {
    const w = await world();
    const worked = await createAssociate({ firstName: 'Ana', lastName: 'Worked' });
    await w.place(worked.id, w.siteA.id);
    await w.punch(worked.id, 3, w.siteA.id, w.coastal.id);

    const scheduled = await createAssociate({ firstName: 'Bo', lastName: 'Scheduled' });
    await w.place(scheduled.id, w.siteA.id);
    await w.shift(scheduled.id, 2, w.siteA.id, w.coastal.id);

    const stale = await createAssociate({ firstName: 'Cy', lastName: 'Stale' });
    await w.place(stale.id, w.siteA.id);
    await w.punch(stale.id, 20, w.siteA.id, w.coastal.id);

    const rejectedOnly = await createAssociate({ firstName: 'Di', lastName: 'Rejected' });
    await w.place(rejectedOnly.id, w.siteA.id);
    await w.punch(rejectedOnly.id, 2, w.siteA.id, w.coastal.id, 'REJECTED');

    const separated = await createAssociate({ firstName: 'Ed', lastName: 'Separated' });
    await w.place(separated.id, w.siteA.id);
    await w.punch(separated.id, 1, w.siteA.id, w.coastal.id);
    await prisma.associate.update({ where: { id: separated.id }, data: { separatedAt: new Date(NOW.getTime() - DAY) } });

    const deactivated = await createAssociate({ firstName: 'Fay', lastName: 'Deactivated' });
    await w.place(deactivated.id, w.siteA.id);
    await w.shift(deactivated.id, 1, w.siteA.id, w.coastal.id);
    await prisma.associate.update({ where: { id: deactivated.id }, data: { deactivatedAt: NOW } });

    const unplaced = await createAssociate({ firstName: 'Gus', lastName: 'Unplaced' });
    await w.punch(unplaced.id, 1, w.siteA.id, w.coastal.id);

    // Approved application and no open assignment anywhere: placed by the application.
    const applied = await createAssociate({ firstName: 'Hal', lastName: 'Applied' });
    await prisma.application.create({ data: { associateId: applied.id, clientId: w.coastal.id, locationId: w.siteA.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: NOW } });
    await w.shift(applied.id, 3, w.siteA.id, w.coastal.id);

    const ids = await activeAssociateIds({}, NOW);
    expect([...ids].sort()).toEqual([worked.id, scheduled.id, applied.id].sort());
    expect(await activeHeadcount({}, NOW)).toBe(3);

    const why = await explainActive(stale.id, NOW);
    expect(why).toMatchObject({ active: false, employed: true, windowDays: 14 });
    expect(why.reason).toMatch(/outside the 14-day window/);
    expect((await explainActive(separated.id, NOW)).reason).toBe('Separated.');
    expect((await explainActive(unplaced.id, NOW)).reason).toMatch(/Not placed/);
    expect((await explainActive(worked.id, NOW)).reason).toMatch(/Clocked in within the last 14 days/);
  });

  it('reads the window from the company setting, and an override wins', async () => {
    const w = await world();
    const a = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await w.place(a.id, w.siteA.id);
    await w.punch(a.id, 20, w.siteA.id, w.coastal.id);
    expect(await activeWindowDays()).toBe(14);
    expect(await activeHeadcount({}, NOW)).toBe(0);
    expect(await activeHeadcount({ windowDays: 30 }, NOW)).toBe(1);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    expect((await admin.patch('/admin/org/settings').send({ activeWindowDays: 30 })).status).toBe(200);
    expect(await activeWindowDays()).toBe(30);
    expect(await activeHeadcount({}, NOW)).toBe(1);
    expect((await admin.patch('/admin/org/settings').send({ activeWindowDays: 0 })).status).toBe(400);
  });

  it('scopes placement and work to a site or a client; a kiosk punch with no site counts under its client', async () => {
    const w = await world();
    const both = await createAssociate({ firstName: 'Ana', lastName: 'Both' });
    await w.place(both.id, w.siteA.id);
    // Worked at B recently (an approved application places her there too), only scheduled at A.
    await prisma.application.create({ data: { associateId: both.id, clientId: w.inland.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: NOW } });
    await w.punch(both.id, 2, w.siteB.id, w.inland.id);
    await w.shift(both.id, 2, w.siteA.id, w.coastal.id);

    const kiosk = await createAssociate({ firstName: 'Bo', lastName: 'Kiosk' });
    await w.place(kiosk.id, w.siteA.id);
    await w.punch(kiosk.id, 1, null, w.coastal.id);

    expect([...(await activeAssociateIds({ locationId: w.siteA.id }, NOW))].sort()).toEqual([both.id, kiosk.id].sort());
    expect([...(await activeAssociateIds({ clientId: w.coastal.id }, NOW))].sort()).toEqual([both.id, kiosk.id].sort());
    // At B she is placed only by the application, and the application does not place someone with an open assignment elsewhere.
    expect([...(await activeAssociateIds({ locationId: w.siteB.id }, NOW))]).toEqual([]);
    expect(await activeHeadcount({}, NOW)).toBe(2);

    const placed = await placements({ clientId: w.coastal.id });
    expect(placed.get(both.id)).toMatchObject({ clientId: w.coastal.id, locationId: w.siteA.id, source: 'assignment' });
    const breakdown = await activeBreakdown(NOW);
    expect(breakdown.total).toBe(2);
    expect(breakdown.byClient.get(w.coastal.id)).toBe(2);
    expect(breakdown.byLocation.get(w.siteA.id)).toBe(2);
  });
});

describe('the surfaces read it', () => {
  it('the directory badge, the clients list, the headcount overview, the executive summary and the dashboard agree', async () => {
    const w = await world();
    const active = await createAssociate({ firstName: 'Ana', lastName: 'Active' });
    await w.place(active.id, w.siteA.id);
    await w.punch(active.id, 1, w.siteA.id, w.coastal.id);
    const approvedOnly = await createAssociate({ firstName: 'Bo', lastName: 'Approved' });
    await prisma.application.create({ data: { associateId: approvedOnly.id, clientId: w.coastal.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: NOW } });
    const separated = await createAssociate({ firstName: 'Cy', lastName: 'Gone' });
    await w.place(separated.id, w.siteA.id);
    await prisma.associate.update({ where: { id: separated.id }, data: { separatedAt: NOW } });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);

    const dir = await admin.get('/people/directory');
    const status = Object.fromEntries(dir.body.associates.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(status[active.id]).toBe('ACTIVE');
    expect(status[approvedOnly.id]).toBe('INACTIVE');
    expect(status[separated.id]).toBe('INACTIVE');

    const overview = await admin.get('/headcount/overview');
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ active: 1, windowDays: 14, scheduledThisWeek: 0, onPayrollLastPeriod: null, inHousing: null, reconciliation: null });
    expect(overview.body.notActive).toMatchObject({ separated: 1, placedNoRecentWork: 1 });
    expect(overview.body.byClient).toEqual([expect.objectContaining({ id: w.coastal.id, active: 1 })]);
    expect(overview.body.byStore).toEqual([expect.objectContaining({ id: w.siteA.id, clientName: 'Coastal Resort', active: 1 })]);

    const snapshot = await admin.get('/headcount/snapshot');
    expect(snapshot.body.total).toBe(1);
    const turnover = await admin.get('/headcount/turnover?days=30');
    expect(turnover.body).toMatchObject({ currentActive: 1, terminations: 1 });

    const dash = await admin.get('/analytics/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.kpis?.activeAssociates ?? dash.body.activeAssociates).toBe(1);

    const clients = await admin.get('/clients');
    const coastal = clients.body.clients.find((c: { id: string }) => c.id === w.coastal.id);
    expect(coastal.activeAssociateCount).toBe(1);

    const exec = await (await loginAs(agent(), (await createUser({ role: 'EXECUTIVE_CHAIRMAN' })).user.email)).get('/executive/summary');
    expect(exec.status).toBe(200);
    expect(exec.body.workforce.active).toBe(1);
    expect(exec.body.clients).toEqual([expect.objectContaining({ clientId: w.coastal.id, activeAssociates: 1 })]);
  });

  it('EMPLOYED_WHERE is the shared employment predicate', () => {
    expect(EMPLOYED_WHERE).toEqual({ deletedAt: null, erasedAt: null, separatedAt: null, deactivatedAt: null });
  });
});
