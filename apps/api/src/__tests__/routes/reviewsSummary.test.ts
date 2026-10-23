import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * GET /performance/reviews/summary (F500 2026-10-22): the review cycle at a
 * glance — drafts, awaiting acknowledgment, done this quarter, and who is
 * due or overdue for a review by the Manager home's rule (a year after the
 * last review's period end, or the hire date).
 */

const DAY = 86_400_000;
const YEAR = 365 * DAY;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function review(associateId: string, status: 'DRAFT' | 'SUBMITTED' | 'ACKNOWLEDGED', periodEnd: Date, acknowledgedAt: Date | null = null) {
  return prisma.performanceReview.create({
    data: { associateId, periodStart: new Date(periodEnd.getTime() - 90 * DAY), periodEnd, overallRating: 4, summary: 'Solid.', status, acknowledgedAt },
  });
}

describe('GET /performance/reviews/summary', () => {
  it('counts the cycle and lists who is due, overdue first', async () => {
    const now = Date.now();
    const [ana, ben, cy, dee, eli, fay, zed] = await Promise.all(
      ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Zed'].map((first) => createAssociate({ firstName: first, lastName: 'Test' })),
    );
    // Ana: last review ended 400 days ago → due 35 days ago (overdue). Acknowledged today; one more from last year.
    const anaEnd = new Date(now - 400 * DAY);
    await review(ana.id, 'ACKNOWLEDGED', anaEnd, new Date(now));
    await review(ana.id, 'ACKNOWLEDGED', new Date(now - 800 * DAY), new Date(now - 700 * DAY));
    // Ben: no review; hired a year ago less a minute → due in a minute (this month).
    const benHired = new Date(now - YEAR + 60_000);
    await prisma.associate.update({ where: { id: ben.id }, data: { hireDate: benHired } });
    // Cy: a review under way (submitted) on an old period — not due, awaiting acknowledgment.
    await review(cy.id, 'SUBMITTED', new Date(now - 500 * DAY));
    // Dee: a draft — not due.
    await review(dee.id, 'DRAFT', new Date(now - 500 * DAY));
    // Eli: hired a month ago — not due. Fay: no review, no hire date — can't tell, not counted.
    await prisma.associate.update({ where: { id: eli.id }, data: { hireDate: new Date(now - 30 * DAY) } });
    void fay;
    // Zed: separated with an old review — not counted.
    await review(zed.id, 'ACKNOWLEDGED', new Date(now - 900 * DAY), new Date(now - 800 * DAY));
    await prisma.associate.update({ where: { id: zed.id }, data: { separatedAt: new Date() } });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const http = await loginAs(agent(), user.email);
    const res = await http.get('/performance/reviews/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ drafts: 1, awaitingAck: 1, acknowledged: 3, doneThisQuarter: 1, overdue: 1, dueThisMonth: 1 });
    expect(res.body.due).toEqual([
      { associateId: ana.id, name: 'Ana Test', lastPeriodEnd: ymd(anaEnd), dueOn: ymd(new Date(anaEnd.getTime() + YEAR)), overdue: true },
      { associateId: ben.id, name: 'Ben Test', lastPeriodEnd: null, dueOn: ymd(new Date(benHired.getTime() + YEAR)), overdue: false },
    ]);

    // "Needs action" is drafts and submitted together.
    const needs = await http.get('/performance/reviews?status=DRAFT,SUBMITTED');
    expect(needs.body.reviews.map((r: { associateName: string }) => r.associateName).sort()).toEqual(['Cy Test', 'Dee Test']);
    const one = await http.get('/performance/reviews?status=SUBMITTED');
    expect(one.body.reviews).toHaveLength(1);
  });
});
