import { describe, expect, it } from 'vitest';
import { punchFetchRange, punchInPeriod, workDayOf } from '../../lib/payrollSchedule.js';
import { runPunchFilter, type RunCut } from '../../lib/payrollRunCut.js';
import { taxYearWindow } from '../../lib/payrollYtd.js';

/**
 * Deep audit 2026-10-29, CODE-1 / CODE-2: the ONE pay-period cut. A punch
 * belongs to the period holding its clock-in's day on the SITE's clock —
 * never the UTC day — and a check's tax year is its pay date's.
 */

const CHI = { timezone: 'America/Chicago' };
const NY = { timezone: 'America/New_York' };
const LA = { timezone: 'America/Los_Angeles' };
const punch = (iso: string, location: { timezone: string } | null = NY, associateId = 'a') => ({ associateId, clockInAt: new Date(iso), location });
const A = { periodStart: '2026-10-10', periodEnd: '2026-10-23' };
const B = { periodStart: '2026-10-24', periodEnd: '2026-11-06' };

describe('the pay-period cut (site day)', () => {
  it('a 7:30 PM Friday clock-in in Chicago on the last day is paid in that period, not the next', () => {
    const p = punch('2026-10-24T00:30:00Z', CHI); // Fri Oct 23, 7:30 PM CDT
    expect(workDayOf(p.clockInAt, CHI.timezone)).toBe('2026-10-23');
    expect(punchInPeriod(p, A)).toBe(true);
    expect(punchInPeriod(p, B)).toBe(false);
    // Fetched by the period's range (a margin day each side) — the UTC cut never fetched it.
    const r = punchFetchRange(A);
    expect(p.clockInAt >= r.gte && p.clockInAt < r.lt).toBe(true);
  });

  it('11:59 PM on the last day belongs to it; midnight starts the next', () => {
    expect(punchInPeriod(punch('2026-10-24T03:59:00Z'), A)).toBe(true); // Fri Oct 23 11:59 PM EDT
    expect(punchInPeriod(punch('2026-10-24T04:00:00Z'), A)).toBe(false); // Sat Oct 24 12:00 AM EDT
    expect(punchInPeriod(punch('2026-10-24T04:00:00Z'), B)).toBe(true);
    // 11:59 PM the evening BEFORE the first day is the previous period's.
    expect(punchInPeriod(punch('2026-10-10T03:59:00Z'), A)).toBe(false); // Fri Oct 9 11:59 PM EDT
  });

  it('the DST weekend (Nov 1, 2026): Saturday 11:30 PM EDT and Sunday 1:30 AM EST land on their own days', () => {
    const sat = punch('2026-11-01T03:30:00Z'); // Sat Oct 31 11:30 PM EDT
    const sun = punch('2026-11-01T06:30:00Z'); // Sun Nov 1 1:30 AM EST (the second 1:30, after the fall back)
    expect(workDayOf(sat.clockInAt, NY.timezone)).toBe('2026-10-31');
    expect(workDayOf(sun.clockInAt, NY.timezone)).toBe('2026-11-01');
    const weekEndingSat = { periodStart: '2026-10-25', periodEnd: '2026-10-31' };
    expect(punchInPeriod(sat, weekEndingSat)).toBe(true);
    expect(punchInPeriod(sun, weekEndingSat)).toBe(false);
  });

  it('the Dec → Jan crossing: New Year’s Eve night shifts stay in Dec 19 – Jan 1; Jan 2 starts the next period', () => {
    const P = { periodStart: '2026-12-19', periodEnd: '2027-01-01' };
    expect(punchInPeriod(punch('2027-01-01T07:00:00Z', LA), P)).toBe(true); // Thu Dec 31 11 PM PST
    expect(punchInPeriod(punch('2027-01-02T03:00:00Z'), P)).toBe(true); // Fri Jan 1 10 PM EST
    expect(punchInPeriod(punch('2027-01-02T05:00:00Z'), P)).toBe(false); // Sat Jan 2 12 AM EST
  });

  it('a site with no zone counts on the company’s day, never UTC’s', () => {
    expect(workDayOf(new Date('2026-10-24T02:00:00Z'), null)).toBe('2026-10-23');
  });

  it('a pay schedule’s run keeps only the person’s days on it', () => {
    const windows = new Map([['a', [{ start: '2026-10-10', end: '2026-10-16' }]]]);
    expect(punchInPeriod(punch('2026-10-15T14:00:00Z'), A, windows)).toBe(true);
    expect(punchInPeriod(punch('2026-10-20T14:00:00Z'), A, windows)).toBe(false);
    expect(punchInPeriod(punch('2026-10-15T14:00:00Z', NY, 'b'), A, windows)).toBe(false);
  });
});

describe('the deploy transition (a UTC-cut run before a site-day run)', () => {
  const legacyPrev: RunCut = { ...B, windows: null, prevUtc: { periodStart: A.periodStart, periodEnd: A.periodEnd, windows: null } };

  it('carries in the evening the UTC-cut run left unpaid, once', () => {
    const keep = runPunchFilter(legacyPrev);
    expect(keep(punch('2026-10-24T00:30:00Z', CHI))).toBe(true); // Fri Oct 23 7:30 PM CDT: the old run's UTC range ended at 00:00Z
    expect(keep(punch('2026-10-23T22:00:00Z', CHI))).toBe(false); // Fri Oct 23 5 PM CDT: the old run paid it
    expect(keep(punch('2026-10-26T14:00:00Z', CHI))).toBe(true); // an ordinary day of this period
  });

  it('never pays twice what the UTC-cut run paid east of UTC (its early morning was the previous UTC day)', () => {
    const keep = runPunchFilter(legacyPrev);
    const tokyo = punch('2026-10-23T23:00:00Z', { timezone: 'Asia/Tokyo' }); // Sat Oct 24 8 AM JST, Fri 23:00 UTC
    expect(workDayOf(tokyo.clockInAt, 'Asia/Tokyo')).toBe('2026-10-24');
    expect(keep(tokyo)).toBe(false);
  });

  it('on a schedule’s run, the carried-in evening is only for people on the schedule that day', () => {
    const cut: RunCut = { ...B, windows: new Map([['a', [B].map((w) => ({ start: w.periodStart, end: w.periodEnd }))]]), prevUtc: { ...A, windows: new Map([['a', [{ start: '2026-10-23', end: '2026-10-23' }]]]) } };
    const keep = runPunchFilter(cut);
    expect(keep(punch('2026-10-24T00:30:00Z', CHI, 'a'))).toBe(true);
    expect(keep(punch('2026-10-24T00:30:00Z', CHI, 'b'))).toBe(false);
  });

  it('a UTC-cut run re-worked after its next run exists keeps the old cut (its evening went to the next run)', () => {
    const keep = runPunchFilter({ ...A, windows: null, prevUtc: null, utc: true });
    expect(keep(punch('2026-10-24T00:30:00Z', CHI))).toBe(false); // Fri 7:30 PM CDT: the next run carried it
    expect(keep(punch('2026-10-10T02:00:00Z', CHI))).toBe(true); // Fri Oct 9 9 PM CDT: the UTC cut paid it here
  });

  it('with no UTC-cut predecessor there is no carry-in', () => {
    const keep = runPunchFilter({ ...B, windows: null, prevUtc: null });
    expect(keep(punch('2026-10-24T00:30:00Z', CHI))).toBe(false);
  });
});

describe('the tax year is the pay date’s (CODE-2)', () => {
  // Calendar days (UTC midnight) for DATE columns; the paid-at bounds are midnights on the
  // company's calendar (Eastern: 05:00 UTC in winter, 04:00 in summer).
  it('the Jan 8, 2027 check for Dec 19 – Jan 1 is a 2027 check', () => {
    const w = taxYearWindow(new Date('2027-01-08T00:00:00Z'));
    expect(w.taxYear).toBe(2027);
    expect(w.yearStart.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(w.before.toISOString()).toBe('2027-01-09T00:00:00.000Z');
    expect(w.paidFrom.toISOString()).toBe('2027-01-01T05:00:00.000Z');
    expect(w.paidBefore.toISOString()).toBe('2027-01-09T05:00:00.000Z');
  });
  it('a Dec 31 pay date counts the whole year and never spills into the next', () => {
    const w = taxYearWindow(new Date('2026-12-31T00:00:00Z'));
    expect(w.taxYear).toBe(2026);
    expect(w.before.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(w.paidBefore.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });
  it('a check paid at 11:30 PM Eastern on the pay day was paid that day, not the next', () => {
    const w = taxYearWindow(new Date('2026-10-29T00:00:00Z'));
    const paid = new Date('2026-10-30T03:30:00Z'); // Thu Oct 29, 11:30 PM EDT
    expect(paid >= w.paidFrom && paid < w.paidBefore).toBe(true);
    expect(w.paidBefore.toISOString()).toBe('2026-10-30T04:00:00.000Z');
  });
});

describe('payroll’s "today" is the company’s day (MONEY-16, MONEY-27)', () => {
  it('9:30 PM Eastern is still today for the pay schedules and the period ledger', async () => {
    const { todayYmd } = await import('../../lib/payScheduleMembership.js');
    expect(todayYmd(new Date('2026-10-30T01:30:00Z'))).toBe('2026-10-29'); // Thu Oct 29, 9:30 PM EDT
    expect(todayYmd(new Date('2027-01-01T02:00:00Z'))).toBe('2026-12-31'); // New Year's Eve, 9 PM EST
  });

  it('year-end opens on the current year from October 1, the year just ended before', async () => {
    const { defaultCloseYear } = await import('../../routes/payroll.js');
    expect(defaultCloseYear(new Date('2026-10-29T16:00:00Z'))).toBe(2026);
    expect(defaultCloseYear(new Date('2026-10-01T04:30:00Z'))).toBe(2026); // Oct 1, 12:30 AM EDT
    expect(defaultCloseYear(new Date('2026-10-01T03:30:00Z'))).toBe(2025); // still Sep 30 in New York
    expect(defaultCloseYear(new Date('2027-02-10T16:00:00Z'))).toBe(2026);
    expect(defaultCloseYear(new Date('2027-01-01T03:00:00Z'))).toBe(2026); // Dec 31, 10 PM EST: still 2026
  });
});
