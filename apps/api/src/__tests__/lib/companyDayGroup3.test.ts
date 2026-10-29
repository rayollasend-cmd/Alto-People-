import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { dueDateFor, nextReminderOn, stageDue } from '../../lib/statementDunning.js';
import { lastClosedPeriod } from '../../lib/integrations/domain.js';
import { endedWeeks } from '../../lib/certifiedPayroll.js';
import { mergePayPeriods } from '../../lib/payPeriods.js';
import { periodsRemainingThisYear } from '../../lib/w4Estimator.js';
import { submitCorrection } from '../../lib/timeCorrections.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * The company-day sweep (2026-10-29, group 3): every one of these used the
 * UTC date, so after 8 PM Eastern (5 PM Pacific) "today" was already
 * tomorrow. Each case is an evening on the company's clock (Eastern, the
 * default) or a store's (Los Angeles) — the hours the old code got wrong.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

describe('statement dunning counts the company\'s days', () => {
  it('the evening before the due date is still the courtesy stage, not "due"', () => {
    // Oct 19, 10 PM Eastern = Oct 20 02:00 UTC.
    expect(stageDue(day('2026-10-20'), new Date('2026-10-20T02:00:00Z'))).toBe(1);
    expect(stageDue(day('2026-10-20'), new Date('2026-10-20T13:00:00Z'))).toBe(2);
    // A week late on the company's calendar, not seven 24-hour blocks from UTC midnight.
    expect(stageDue(day('2026-10-20'), new Date('2026-10-27T02:00:00Z'))).toBe(2);
    expect(stageDue(day('2026-10-20'), new Date('2026-10-27T15:00:00Z'))).toBe(3);
  });

  it('a statement finalized late in the evening is due from the day it was finalized', () => {
    // Sep 30, 10:30 PM Eastern.
    expect(dueDateFor(new Date('2026-10-01T02:30:00Z'), 15).toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('the next reminder is a calendar day after the due date', () => {
    expect(nextReminderOn(day('2026-10-20'), 2)).toBe('2026-10-27');
    expect(nextReminderOn(day('2026-10-20'), 5)).toBeNull();
  });
});

describe('the integrations\' last closed period', () => {
  it('on Friday evening the current week is not closed yet', () => {
    // Fri Oct 30, 10 PM Eastern: the period ending tonight is still open.
    expect(lastClosedPeriod(new Date('2026-10-31T02:00:00Z'))).toEqual({ periodStart: '2026-10-10', periodEnd: '2026-10-23' });
    // Saturday noon: it has closed.
    expect(lastClosedPeriod(new Date('2026-10-31T16:00:00Z'))).toEqual({ periodStart: '2026-10-17', periodEnd: '2026-10-30' });
  });
});

describe('certified payroll weeks', () => {
  it('a week ending Saturday has not ended at 10 PM that Saturday', () => {
    const project = { startDate: day('2026-10-04'), endDate: null, weekEndsOn: 6 };
    expect(endedWeeks(project, new Date('2026-11-01T02:00:00Z'))).toEqual(['2026-10-10', '2026-10-17', '2026-10-24']);
    expect(endedWeeks(project, new Date('2026-11-01T12:00:00Z'))).toEqual(['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31']);
  });
});

describe('pay periods', () => {
  it('Sunday evening is still the week that ends Sunday', () => {
    const windows = [
      { periodStart: '2026-06-29', periodEnd: '2026-07-05', payDate: '2026-07-10' },
      { periodStart: '2026-07-06', periodEnd: '2026-07-12', payDate: '2026-07-17' },
    ];
    // Jul 5, 10 PM Eastern.
    const merged = mergePayPeriods(windows, [], new Date('2026-07-06T02:00:00Z'));
    expect(merged.find((p) => p.current)?.start).toBe('2026-06-29');
  });
});

describe('the W-4 estimator', () => {
  it('New Year\'s Eve evening counts no checks from next year', () => {
    const schedule = { frequency: 'WEEKLY' as const, anchorDate: '2026-01-03', payDateOffsetDays: 6 };
    // Dec 31, 10 PM Eastern = Jan 1 03:00 UTC: the year is still 2026, and its checks are all paid.
    expect(periodsRemainingThisYear(schedule, new Date('2027-01-01T03:00:00Z'))).toBe(0);
    expect(periodsRemainingThisYear(schedule, new Date('2026-12-01T15:00:00Z'))).toBeGreaterThan(0);
  });
});

describe('a punch correction\'s work day', () => {
  it('is the day on the store\'s clock: a 7 PM Pacific shift stays on its own day', async () => {
    const LA = 'America/Los_Angeles';
    const client = await createClient('Pacific Hotels');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: store.id }, data: { timezone: LA } });
    const person = await createAssociate({ firstName: 'Rosa' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: person.id });
    await prisma.associateAssignment.create({ data: { associateId: person.id, locationId: store.id, startedAt: day('2026-01-02') } });
    // Oct 20, 7 PM → 11 PM Pacific = Oct 21 02:00 → 06:00 UTC.
    const row = await submitCorrection(
      prisma,
      { tenantId: ALTO_TENANT_ID, associateId: person.id, userId: user.id },
      { kind: 'NEW_ENTRY', siteId: store.id, proposedClockIn: '2026-10-21T02:00:00.000Z', proposedClockOut: '2026-10-21T06:00:00.000Z', reason: 'Forgot to punch', attested: true },
    );
    expect(row.workDate?.toISOString().slice(0, 10)).toBe('2026-10-20');
  });
});
