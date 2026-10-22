import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { hiresBetween, onTheBooksAt, peopleStandings, turnoverBetween } from '../../lib/peopleStatus.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * One status per person, one number per concept (F500 SH-4).
 *
 * The same seeded people must read the same on every surface: the People
 * directory's rows and tiles, the Headcount screen, Analytics, People
 * analytics and Employers of record. Before, "how many people" read 0, 8,
 * 10, 14 and 17 on five pages of one tenant.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const NOW = new Date(Date.now() - 60_000);

async function seed() {
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const approve = (associateId: string, approvedAt = new Date(NOW.getTime() - 40 * DAY)) =>
    prisma.application.create({ data: { associateId, clientId: client.id, locationId: site.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt } });
  const draft = (associateId: string) =>
    prisma.application.create({ data: { associateId, clientId: client.id, onboardingTrack: 'STANDARD', status: 'DRAFT' } });
  const place = (associateId: string) => prisma.associateAssignment.create({ data: { associateId, locationId: site.id, startedAt: new Date('2026-05-01') } });

  // Working: placed, punched three days ago.
  const working = await createAssociate({ firstName: 'Ana', lastName: 'Working' });
  await approve(working.id, new Date(NOW.getTime() - 20 * DAY));
  await place(working.id);
  await prisma.timeEntry.create({ data: { associateId: working.id, clientId: client.id, locationId: site.id, clockInAt: new Date(NOW.getTime() - 3 * DAY), clockOutAt: new Date(NOW.getTime() - 3 * DAY + 8 * 3_600_000), status: 'APPROVED' } });
  // No recent shifts: placed by an assignment, and placed by an approved application alone.
  const idleAssigned = await createAssociate({ firstName: 'Bo', lastName: 'Idle' });
  await approve(idleAssigned.id);
  await place(idleAssigned.id);
  const idleApplied = await createAssociate({ firstName: 'Cy', lastName: 'Applied' });
  await approve(idleApplied.id);
  // Not placed: on file, no application, no placement (an office hire made by hand).
  const unplaced = await createAssociate({ firstName: 'Di', lastName: 'Unplaced' });
  await prisma.associate.update({ where: { id: unplaced.id }, data: { hireDate: new Date(NOW.getTime() - 200 * DAY) } });
  // Onboarding: a draft and nothing approved.
  const onboarding = await createAssociate({ firstName: 'Ed', lastName: 'Onboarding' });
  await draft(onboarding.id);
  // Paused: deactivated by hand, still placed.
  const paused = await createAssociate({ firstName: 'Fay', lastName: 'Paused' });
  await approve(paused.id);
  await place(paused.id);
  await prisma.associate.update({ where: { id: paused.id }, data: { deactivatedAt: new Date(NOW.getTime() - 2 * DAY) } });
  // Separated ten days ago.
  const separated = await createAssociate({ firstName: 'Gus', lastName: 'Separated' });
  await approve(separated.id, new Date(NOW.getTime() - 100 * DAY));
  await prisma.associate.update({ where: { id: separated.id }, data: { separatedAt: new Date(NOW.getTime() - 10 * DAY) } });
  // Separated, and a rehire application in flight: onboarding again.
  const rehire = await createAssociate({ firstName: 'Hal', lastName: 'Rehire' });
  await approve(rehire.id, new Date(NOW.getTime() - 300 * DAY));
  await prisma.associate.update({ where: { id: rehire.id }, data: { separatedAt: new Date(NOW.getTime() - 60 * DAY) } });
  await draft(rehire.id);
  // Another tenant's person never counts.
  const other = await prisma.tenant.create({ data: { name: 'Other staffing', slug: `other-${Date.now()}` } });
  await prisma.associate.create({ data: { tenantId: other.id, firstName: 'Zed', lastName: 'Elsewhere', email: `zed-${Date.now()}@example.com` } });

  return { client, site, working, idleAssigned, idleApplied, unplaced, onboarding, paused, separated, rehire };
}

const EXPECTED = { ACTIVE: 1, PLACED_NOT_ACTIVE: 2, NOT_PLACED: 1, ONBOARDING: 2, DEACTIVATED: 1, SEPARATED: 1, onTheBooks: 5, total: 8 };

describe('one status per person, the same number on every page', () => {
  it('the directory rows, the directory tiles, Headcount, Analytics and People analytics agree', async () => {
    const s = await seed();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), user.email);

    // People directory: one status per row.
    const list = await a.get('/people/directory');
    expect(list.status).toBe(200);
    const byName = new Map<string, { status: string; workStatus: string }>(list.body.associates.map((r: { firstName: string; status: string; workStatus: string }) => [r.firstName, r]));
    expect(byName.get('Ana')).toMatchObject({ workStatus: 'ACTIVE', status: 'ACTIVE' });
    expect(byName.get('Bo')).toMatchObject({ workStatus: 'PLACED_NOT_ACTIVE', status: 'INACTIVE' });
    expect(byName.get('Cy')).toMatchObject({ workStatus: 'PLACED_NOT_ACTIVE', status: 'INACTIVE' });
    expect(byName.get('Di')).toMatchObject({ workStatus: 'NOT_PLACED', status: 'INACTIVE' });
    expect(byName.get('Ed')).toMatchObject({ workStatus: 'ONBOARDING', status: 'PENDING' });
    expect(byName.get('Fay')).toMatchObject({ workStatus: 'DEACTIVATED', status: 'INACTIVE' });
    expect(byName.get('Gus')).toMatchObject({ workStatus: 'SEPARATED', status: 'INACTIVE' });
    expect(byName.get('Hal')).toMatchObject({ workStatus: 'ONBOARDING', status: 'PENDING' });
    expect(byName.has('Zed')).toBe(false);
    const rowCounts: Record<string, number> = {};
    for (const r of list.body.associates as Array<{ workStatus: string }>) rowCounts[r.workStatus] = (rowCounts[r.workStatus] ?? 0) + 1;

    // The tiles: the same counts, and each one is the list it filters.
    const summary = await a.get('/people/directory/summary');
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ ...EXPECTED, windowDays: 14 });
    for (const [k, n] of Object.entries(rowCounts)) expect(summary.body[k]).toBe(n);
    const filtered = await a.get('/people/directory?workStatus=PLACED_NOT_ACTIVE');
    expect(filtered.body.associates.map((r: { firstName: string }) => r.firstName).sort()).toEqual(['Bo', 'Cy']);

    // Headcount: the same reading.
    const hc = await a.get('/headcount/overview');
    expect(hc.status).toBe(200);
    expect(hc.body.active).toBe(EXPECTED.ACTIVE);
    expect(hc.body.onTheBooks).toBe(EXPECTED.onTheBooks);
    expect(hc.body.notActive).toEqual({ employedNotPlaced: 1, placedNoRecentWork: 2, separated: 1, deactivated: 1, onboarding: 2 });
    expect(hc.body.statusCounts).toMatchObject(EXPECTED);

    // Analytics: "Working" and "On the books", named once.
    const an = await a.get('/analytics/dashboard');
    expect(an.status).toBe(200);
    expect(an.body.activeAssociates).toBe(EXPECTED.ACTIVE);
    expect(an.body.onTheBooks).toBe(EXPECTED.onTheBooks);
    expect(an.body.activeWindowDays).toBe(14);

    // People analytics: on the books today, and this month's headcount point is the same number.
    const pa = await a.get('/people-analytics?months=12');
    expect(pa.status).toBe(200);
    expect(pa.body.onTheBooks).toBe(EXPECTED.onTheBooks);
    expect(pa.body.working).toBe(EXPECTED.ACTIVE);
    expect(pa.body.headcount[pa.body.headcount.length - 1].headcount).toBe(EXPECTED.onTheBooks);
    void s;
  });

  it('hires and turnover: one count and one formula for Headcount and People analytics', async () => {
    await seed();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), user.email);
    const standings = await peopleStandings({ tenantId: ALTO_TENANT_ID }, NOW);

    // Hires in the last 90 days, by hire date: Ana (20d), Bo, Cy, Fay (40d). Gus (100d) and Hal (300d) were earlier; Di 200d.
    const since = new Date(Date.now() - 90 * DAY);
    expect(hiresBetween(standings, since, new Date())).toBe(4);
    const turnover = await a.get('/headcount/turnover?days=90');
    expect(turnover.status).toBe(200);
    expect(turnover.body.hires).toBe(4);
    // Separations in the window: Gus (10d) and Hal (60d).
    expect(turnover.body.terminations).toBe(2);
    expect(turnover.body.onTheBooks).toBe(5);
    expect(turnover.body.currentActive).toBe(1);
    const t = turnoverBetween(standings, since, new Date());
    expect(turnover.body.annualizedTurnoverRate).toBe(t.annualizedPct);
    // On the books 90 days ago: Di (200d), Gus (100d, left 10d ago), Hal (300d, left 60d ago) = 3; today 5.
    expect(onTheBooksAt(standings, since)).toBe(3);
    expect(onTheBooksAt(standings, NOW)).toBe(5);

    // People analytics' month-by-month hires are the same hire dates.
    const pa = await a.get('/people-analytics?months=12');
    const monthHires = (pa.body.headcount as Array<{ hires: number }>).reduce((n, m) => n + m.hires, 0);
    const yearStart = new Date(pa.body.since + 'T00:00:00.000Z');
    expect(monthHires).toBe(hiresBetween(standings, yearStart, new Date(Date.now() + 40 * DAY)));
  });

  it('Employers counts only people on the books', async () => {
    const s = await seed();
    const employer = await prisma.employerOrganization.create({ data: { kind: 'THIRD_PARTY', legalName: 'Coastal EOR' } });
    for (const p of [s.working, s.idleAssigned, s.paused, s.separated]) {
      await prisma.employment.create({ data: { associateId: p.id, employerOrgId: employer.id, hireDate: new Date('2026-01-01') } });
    }
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), user.email);
    const res = await a.get('/admin/employers');
    expect(res.status).toBe(200);
    const row = res.body.employers.find((e: { legalName: string }) => e.legalName === 'Coastal EOR');
    // The separated person's spell was left open; they are not employed.
    expect(row.employments).toBe(3);
  });
});
