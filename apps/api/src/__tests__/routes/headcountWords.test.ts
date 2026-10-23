import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { startOfWeekUTC } from '../../lib/timeAnomalies.js';

/**
 * Headcount (F500 2026-10-22): "Working 0" beside "Scheduled this week 2"
 * explains itself — how many of the scheduled are not Working — and the
 * payroll tile names the last run and when it was finalized, not "last
 * period".
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /headcount/overview', () => {
  it('counts the scheduled who are not Working, and dates the last payroll run', async () => {
    const now = Date.now();
    const weekStart = startOfWeekUTC(new Date()).getTime();
    // Needs an hour of this week behind us for a shift that already started.
    if (now - weekStart < 2 * HOUR) return;
    const coastal = await createClient('Coastal Resort');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: coastal.id } });
    const shift = (associateId: string, startsAt: number) =>
      prisma.shift.create({ data: { clientId: coastal.id, locationId: site.id, position: 'Associate', startsAt: new Date(startsAt), endsAt: new Date(startsAt + HOUR), status: 'ASSIGNED', assignedAssociateId: associateId, publishedAt: new Date(startsAt - DAY) } });
    const [ana, bo, cy] = await Promise.all([
      createAssociate({ firstName: 'Ana', lastName: 'Worked' }),
      createAssociate({ firstName: 'Bo', lastName: 'Missed' }),
      createAssociate({ firstName: 'Cy', lastName: 'Missed' }),
    ]);
    for (const a of [ana, bo, cy]) {
      await prisma.application.create({ data: { associateId: a.id, clientId: coastal.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date('2026-05-01') } });
      await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-05-01') } });
    }
    // Ana worked yesterday's hour and has a shift earlier this week: Working.
    await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: coastal.id, locationId: site.id, clockInAt: new Date(now - DAY), clockOutAt: new Date(now - DAY + HOUR), status: 'APPROVED' } });
    await shift(ana.id, weekStart + 30 * 60_000);
    // Bo and Cy had a shift this week that already started, and no work: not Working.
    await shift(bo.id, weekStart + 30 * 60_000);
    await shift(cy.id, weekStart + 45 * 60_000);
    await prisma.payrollRun.create({ data: { clientId: coastal.id, periodStart: new Date('2026-08-29T00:00:00Z'), periodEnd: new Date('2026-09-11T00:00:00Z'), status: 'FINALIZED', finalizedAt: new Date('2026-09-16T15:00:00Z') } });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await (await loginAs(agent(), user.email)).get('/headcount/overview');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(1);
    expect(res.body.scheduledThisWeek).toBe(3);
    expect(res.body.scheduledNotWorking).toBe(2);
    expect(res.body.onPayrollLastPeriod).toEqual({ count: 0, periodStart: '2026-08-29', periodEnd: '2026-09-11', finalizedOn: '2026-09-16' });
  });
});
