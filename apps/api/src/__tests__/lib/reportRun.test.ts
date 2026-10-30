import { describe, expect, it } from 'vitest';
import { buildWhere, resolvePeriodWindow } from '../../lib/reportRun.js';

/**
 * Relative period tokens — pure resolution tests, no DB. The point of the
 * feature is that the SAME saved spec resolves to a different window on a
 * different run date, so several cases pin two `now`s a week apart.
 *
 * Org week: Saturday 00:00 → Friday 24:00 America/New_York. August is EDT
 * (UTC-4), so a local Saturday midnight is 04:00Z; January is EST (UTC-5).
 */

// Wednesday 2026-08-12, mid-week. Its org week is Sat 2026-08-08 → Sat 2026-08-15.
const WED_AUG_12 = new Date('2026-08-12T15:00:00.000Z');
// One week later — same weekday, next org week.
const WED_AUG_19 = new Date('2026-08-19T15:00:00.000Z');

describe('resolvePeriodWindow', () => {
  it('this-week spans the Saturday-start org week containing now', () => {
    const w = resolvePeriodWindow('this-week', WED_AUG_12);
    expect(w.start.toISOString()).toBe('2026-08-08T04:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-08-15T04:00:00.000Z');
  });

  it('last-week is the full org week before this one', () => {
    const w = resolvePeriodWindow('last-week', WED_AUG_12);
    expect(w.start.toISOString()).toBe('2026-08-01T04:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-08-08T04:00:00.000Z');
  });

  it('the same token resolves to different windows on different run dates', () => {
    const first = resolvePeriodWindow('last-week', WED_AUG_12);
    const second = resolvePeriodWindow('last-week', WED_AUG_19);
    expect(second.start.getTime()).not.toBe(first.start.getTime());
    // The later run's window is exactly the earlier run's "this week".
    expect(second.start.toISOString()).toBe('2026-08-08T04:00:00.000Z');
    expect(second.end.toISOString()).toBe('2026-08-15T04:00:00.000Z');
  });

  it('last-month is the previous org-local calendar month', () => {
    const w = resolvePeriodWindow('last-month', WED_AUG_12);
    expect(w.start.toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-08-01T04:00:00.000Z');
  });

  it('last-month crosses the year boundary in January (and EST offsets apply)', () => {
    const w = resolvePeriodWindow('last-month', new Date('2026-01-15T12:00:00.000Z'));
    expect(w.start.toISOString()).toBe('2025-12-01T05:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-01-01T05:00:00.000Z');
  });

  it('to-date tokens start at the org-local period boundary and end at now', () => {
    const mtd = resolvePeriodWindow('month-to-date', WED_AUG_12);
    expect(mtd.start.toISOString()).toBe('2026-08-01T04:00:00.000Z');
    expect(mtd.end.getTime()).toBe(WED_AUG_12.getTime());

    const ytd = resolvePeriodWindow('year-to-date', WED_AUG_12);
    expect(ytd.start.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(ytd.end.getTime()).toBe(WED_AUG_12.getTime());
  });
});

describe('buildWhere with period filters', () => {
  const lastWeekSpec = [{ column: 'clockIn', op: 'period' as const, value: 'last-week' }];

  it('expands a token to a [gte, lt) range on the mapped Prisma column', () => {
    const where = buildWhere('TIME_ENTRY', lastWeekSpec, WED_AUG_12);
    expect(where).toEqual({
      clockInAt: {
        gte: new Date('2026-08-01T04:00:00.000Z'),
        lt: new Date('2026-08-08T04:00:00.000Z'),
      },
    });
  });

  it('a report saved once resolves different windows when run a week apart', () => {
    const first = buildWhere('TIME_ENTRY', lastWeekSpec, WED_AUG_12) as {
      clockInAt: { gte: Date; lt: Date };
    };
    const second = buildWhere('TIME_ENTRY', lastWeekSpec, WED_AUG_19) as {
      clockInAt: { gte: Date; lt: Date };
    };
    expect(second.clockInAt.gte.getTime()).toBe(first.clockInAt.lt.getTime());
    expect(second.clockInAt.lt.getTime() - second.clockInAt.gte.getTime()).toBe(
      7 * 24 * 3600 * 1000,
    );
  });

  it('rejects a period filter on a non-date column', () => {
    expect(() =>
      buildWhere(
        'TIME_ENTRY',
        [{ column: 'status', op: 'period', value: 'last-week' }],
        WED_AUG_12,
      ),
    ).toThrow(/not a date column/);
  });

  it('rejects an unknown token', () => {
    expect(() =>
      buildWhere(
        'TIME_ENTRY',
        [{ column: 'clockIn', op: 'period', value: 'fortnight-ago' }],
        WED_AUG_12,
      ),
    ).toThrow(/relative-period token/);
  });
});

describe('buildWhere with days', () => {
  // Sentry ALTO-PEOPLE-API-17: Hugo's run_report sent clockIn gte "2026-10-30"
  // and Prisma rejected the bare day — a 500. A day is now that whole day.
  it('a bare day on a timestamp is the company-time day, and a from/to pair both hold', () => {
    const where = buildWhere('TIME_ENTRY', [
      { column: 'clockIn', op: 'gte', value: '2026-10-30' },
      { column: 'clockIn', op: 'lte', value: '2026-11-01' },
    ]);
    // Oct 30 starts at 04:00Z (EDT); "through Nov 1" ends at Nov 2's midnight, 05:00Z (EST).
    expect(where).toEqual({
      clockInAt: { gte: new Date('2026-10-30T04:00:00.000Z'), lt: new Date('2026-11-02T05:00:00.000Z') },
    });
  });

  it('gt starts the next day, lt ends before the day, eq and ne are the whole day', () => {
    const day = (op: 'gt' | 'lt' | 'eq' | 'ne') => buildWhere('EXPENSE', [{ column: 'paidAt', op, value: '2026-08-12' }]).paidAt;
    expect(day('gt')).toEqual({ gte: new Date('2026-08-13T04:00:00.000Z') });
    expect(day('lt')).toEqual({ lt: new Date('2026-08-12T04:00:00.000Z') });
    expect(day('eq')).toEqual({ gte: new Date('2026-08-12T04:00:00.000Z'), lt: new Date('2026-08-13T04:00:00.000Z') });
    expect(day('ne')).toEqual({ not: { gte: new Date('2026-08-12T04:00:00.000Z'), lt: new Date('2026-08-13T04:00:00.000Z') } });
  });

  it('a calendar-day column compares at the UTC midnight it is stored at', () => {
    expect(buildWhere('PAYROLL_RUN', [{ column: 'periodStart', op: 'eq', value: '2026-10-17' }])).toEqual({
      periodStart: { gte: new Date('2026-10-17T00:00:00.000Z'), lt: new Date('2026-10-18T00:00:00.000Z') },
    });
    expect(buildWhere('PAYROLL_RUN', [{ column: 'periodStart', op: 'in', value: ['2026-10-03', '2026-10-17'] }])).toEqual({
      periodStart: { in: [new Date('2026-10-03T00:00:00.000Z'), new Date('2026-10-17T00:00:00.000Z')] },
    });
  });

  it('a full timestamp is that instant, and null still means "not set"', () => {
    expect(buildWhere('TIME_ENTRY', [{ column: 'clockIn', op: 'lte', value: '2026-10-30T00:00:00.000Z' }])).toEqual({
      clockInAt: { lte: new Date('2026-10-30T00:00:00.000Z') },
    });
    expect(buildWhere('ASSOCIATE', [{ column: 'separatedAt', op: 'eq', value: null }])).toEqual({ separatedAt: null });
    expect(buildWhere('ASSOCIATE', [{ column: 'separatedAt', op: 'ne', value: null }])).toEqual({ separatedAt: { not: null } });
  });

  it('a period and a day on one column both hold', () => {
    expect(buildWhere('TIME_ENTRY', [
      { column: 'clockIn', op: 'period', value: 'last-week' },
      { column: 'clockIn', op: 'gte', value: '2026-08-05' },
    ], WED_AUG_12)).toEqual({
      clockInAt: { gte: new Date('2026-08-05T04:00:00.000Z'), lt: new Date('2026-08-08T04:00:00.000Z') },
    });
  });

  it('refuses what is not a day with a 400, not a database error', () => {
    const bad = (column: string, op: 'gte' | 'in' | 'contains', value: unknown) => () => buildWhere(column === 'periodStart' ? 'PAYROLL_RUN' : 'TIME_ENTRY', [{ column, op, value }]);
    expect(bad('clockIn', 'gte', 'yesterday')).toThrow(/YYYY-MM-DD/);
    expect(bad('clockIn', 'gte', '2026-02-30')).toThrow(/YYYY-MM-DD/);
    expect(bad('clockIn', 'gte', 20261030)).toThrow(/YYYY-MM-DD/);
    expect(bad('periodStart', 'in', ['2026-10-03', 'soon'])).toThrow(/YYYY-MM-DD/);
    expect(bad('clockIn', 'in', ['2026-10-30'])).toThrow(/timestamp/);
    expect(bad('clockIn', 'contains', '2026')).toThrow(/is a date/);
  });
});
