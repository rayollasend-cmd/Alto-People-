import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pinMidweekNoon } from '../../../test/clock.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';
import { computeExecutiveSummary } from '../../lib/executiveSummary.js';
import { loadPaidHours, paidHoursByWeek, paidHoursByWeekSql, totalPaid, weekStartsEndingWith, weeklyPaidHours } from '../../lib/paidHours.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Paid hours — the one "hours worked" (lib/paidHours): approved or
 * completed punches, every break out, each week split as pay splits it. The
 * SQL path Analytics uses and the per-punch path must agree to the
 * hundredth, and both must equal the executive summary's week.
 */

const H = 3_600_000;
const MIN = 60_000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function world(now: Date) {
  const [, lastWeek, thisWeek] = weekStartsEndingWith(now, 3);
  const client = await createClient('Paid Hours Co');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Long' });
  const ben = await createAssociate({ firstName: 'Ben', lastName: 'Short' });
  const at = (d: Date, dayOffset: number, hour: number) => new Date(d.getTime() + dayOffset * 24 * H + hour * H);
  const punch = async (associateId: string, start: Date, hours: number, status: 'APPROVED' | 'COMPLETED' | 'REJECTED' | 'ACTIVE' = 'APPROVED', breaks: Array<{ from: number; minutes: number | null }> = []) =>
    prisma.timeEntry.create({
      data: {
        associateId,
        clientId: client.id,
        locationId: site.id,
        clockInAt: start,
        clockOutAt: status === 'ACTIVE' ? null : new Date(start.getTime() + hours * H),
        status,
        breaks: {
          create: breaks.map((b) => ({
            type: 'MEAL' as const,
            startedAt: new Date(start.getTime() + b.from * H),
            endedAt: b.minutes === null ? null : new Date(start.getTime() + b.from * H + b.minutes * MIN),
          })),
        },
      },
    });
  // Ana, last week: five 9-hour days with a 30-minute lunch = 42.5 paid, 2.5 of it overtime.
  for (let d = 0; d < 5; d++) await punch(ana.id, at(lastWeek!, d, 13), 9, d % 2 ? 'COMPLETED' : 'APPROVED', [{ from: 4, minutes: 30 }]);
  // Never paid: a rejected punch, an open one.
  await punch(ana.id, at(lastWeek!, 5, 13), 8, 'REJECTED');
  await punch(ben.id, at(thisWeek!, 0, 13), 0, 'ACTIVE');
  // Ben, last week: a break never closed runs to the clock-out (6 h span, break from hour 4 → 4 paid).
  await punch(ben.id, at(lastWeek!, 1, 14), 6, 'APPROVED', [{ from: 4, minutes: null }]);
  // Ben, this week so far: 7.25 h less a 15-minute break.
  await punch(ben.id, new Date(thisWeek!.getTime() + 2 * H), 7.25, 'COMPLETED', [{ from: 2, minutes: 15 }]);
  return { client, site, ana, ben };
}

describe('paid hours', () => {
  it('docks every break, skips rejected and open punches, and splits the week as pay does', async () => {
    const now = pinMidweekNoon();
    const { ana } = await world(now);
    const [, lastWeek, thisWeek] = weekStartsEndingWith(now, 3);
    const shares = await loadPaidHours(prisma, { tenantId: ALTO_TENANT_ID, from: lastWeek!, to: thisWeek! });
    const t = totalPaid(shares);
    expect(t.hours).toBe(46.5);
    expect(t.otHours).toBe(2.5);
    expect(t.heads).toBe(2);
    expect(totalPaid(shares, undefined, undefined, (s) => s.entry.associateId === ana.id).hours).toBe(42.5);
  });

  it('the SQL path and the per-punch path agree to the hundredth', async () => {
    const now = pinMidweekNoon();
    await world(now);
    const weekStarts = weekStartsEndingWith(now, 8);
    const sql = await paidHoursByWeekSql(prisma, { tenantId: ALTO_TENANT_ID, weekStarts, end: now });
    const js = weeklyPaidHours(await loadPaidHours(prisma, { tenantId: ALTO_TENANT_ID, from: weekStarts[0]!, to: now }), weekStarts, now);
    expect(sql).toEqual(js);
    expect(sql.slice(-2)).toEqual([46.5, 7]);
    // With nothing live, the helper takes the SQL path; the answer is the same.
    expect(await paidHoursByWeek(prisma, { tenantId: ALTO_TENANT_ID, weekStarts, end: now })).toEqual(js);
  });

  it('narrows to a client and to sites the same way on both paths', async () => {
    const now = pinMidweekNoon();
    const { client, site } = await world(now);
    const weekStarts = weekStartsEndingWith(now, 3);
    const other = await createClient('Elsewhere');
    expect(await paidHoursByWeekSql(prisma, { tenantId: ALTO_TENANT_ID, weekStarts, end: now, clientId: other.id })).toEqual([0, 0, 0]);
    expect(await paidHoursByWeekSql(prisma, { tenantId: ALTO_TENANT_ID, weekStarts, end: now, clientId: client.id })).toEqual([0, 46.5, 7]);
    expect(await paidHoursByWeekSql(prisma, { tenantId: ALTO_TENANT_ID, weekStarts, end: now, siteIds: [site.id] })).toEqual([0, 46.5, 7]);
    expect(await paidHoursByWeekSql(prisma, { tenantId: ALTO_TENANT_ID, weekStarts, end: now, siteIds: [] })).toEqual([0, 0, 0]);
  });

  it('a week is the executive summary’s week', async () => {
    const now = pinMidweekNoon();
    await world(now);
    const summary = await computeExecutiveSummary(prisma, now, { tenantId: ALTO_TENANT_ID });
    const [, lastWeek, thisWeek] = weekStartsEndingWith(now, 3);
    const t = totalPaid(await loadPaidHours(prisma, { tenantId: ALTO_TENANT_ID, from: lastWeek!, to: thisWeek! }));
    expect(t.hours).toBe(summary.lastWeek.workedHours);
    expect(t.otHours).toBe(summary.lastWeek.otHours);
    expect(t.billed).toBe(summary.lastWeek.estBilled);
    expect(t.margin).toBe(summary.lastWeek.estMargin);
  });
});
