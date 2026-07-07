import { describe, expect, it } from 'vitest';
import { mergePayPeriods, recentSchedulePeriods } from '../../lib/payPeriods.js';

const day = (s: string) => new Date(`${s}T12:00:00Z`);

describe('recentSchedulePeriods', () => {
  it('WEEKLY: returns count contiguous cycles ending with the one containing now', () => {
    const periods = recentSchedulePeriods(
      { frequency: 'WEEKLY', anchorDate: '2026-01-05', payDateOffsetDays: 5 },
      day('2026-01-21'), // Wednesday of week 3
      3,
    );
    expect(periods.map((p) => [p.periodStart, p.periodEnd])).toEqual([
      ['2026-01-05', '2026-01-11'],
      ['2026-01-12', '2026-01-18'],
      ['2026-01-19', '2026-01-25'],
    ]);
  });

  it('BIWEEKLY: steps back 14 days per period', () => {
    const periods = recentSchedulePeriods(
      { frequency: 'BIWEEKLY', anchorDate: '2026-01-05', payDateOffsetDays: 5 },
      day('2026-02-10'),
      2,
    );
    expect(periods.map((p) => [p.periodStart, p.periodEnd])).toEqual([
      ['2026-01-19', '2026-02-01'],
      ['2026-02-02', '2026-02-15'],
    ]);
  });

  it('SEMIMONTHLY: alternates halves and crosses month boundaries', () => {
    const periods = recentSchedulePeriods(
      { frequency: 'SEMIMONTHLY', anchorDate: '2026-01-01', payDateOffsetDays: 5 },
      day('2026-03-10'), // first half of March
      4,
    );
    expect(periods.map((p) => [p.periodStart, p.periodEnd])).toEqual([
      ['2026-01-16', '2026-01-31'],
      ['2026-02-01', '2026-02-15'],
      ['2026-02-16', '2026-02-28'],
      ['2026-03-01', '2026-03-15'],
    ]);
  });

  it('MONTHLY: walks back calendar months, including across a year boundary', () => {
    const periods = recentSchedulePeriods(
      { frequency: 'MONTHLY', anchorDate: '2025-06-01', payDateOffsetDays: 5 },
      day('2026-02-10'),
      3,
    );
    expect(periods.map((p) => [p.periodStart, p.periodEnd])).toEqual([
      ['2025-12-01', '2025-12-31'],
      ['2026-01-01', '2026-01-31'],
      ['2026-02-01', '2026-02-28'],
    ]);
  });

  it('periods are contiguous: each start is the day after the previous end', () => {
    const periods = recentSchedulePeriods(
      { frequency: 'SEMIMONTHLY', anchorDate: '2026-01-01', payDateOffsetDays: 5 },
      day('2026-07-07'),
      8,
    );
    for (let i = 1; i < periods.length; i++) {
      const prevEnd = new Date(`${periods[i - 1].periodEnd}T00:00:00.000Z`);
      const nextStart = new Date(`${periods[i].periodStart}T00:00:00.000Z`);
      expect(nextStart.getTime() - prevEnd.getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });
});

describe('mergePayPeriods', () => {
  const win = (periodStart: string, periodEnd: string) => ({
    periodStart,
    periodEnd,
    payDate: periodEnd, // irrelevant to the merge
  });

  it('collapses a window present in both sources into one entry with hasRun', () => {
    const merged = mergePayPeriods(
      [win('2026-06-22', '2026-06-28'), win('2026-06-29', '2026-07-05')],
      [{ start: '2026-06-22', end: '2026-06-28' }],
      day('2026-07-01'),
    );
    expect(merged).toEqual([
      { start: '2026-06-29', end: '2026-07-05', current: true, hasRun: false },
      { start: '2026-06-22', end: '2026-06-28', current: false, hasRun: true },
    ]);
  });

  it('keeps run-only windows (history from before the schedule existed)', () => {
    const merged = mergePayPeriods(
      [win('2026-06-29', '2026-07-05')],
      [{ start: '2026-06-01', end: '2026-06-14' }],
      day('2026-07-01'),
    );
    expect(merged.map((p) => p.start)).toEqual(['2026-06-29', '2026-06-01']);
    expect(merged[1].hasRun).toBe(true);
  });

  it('marks exactly the window containing now as current (boundaries inclusive)', () => {
    const merged = mergePayPeriods(
      [win('2026-06-22', '2026-06-28'), win('2026-06-29', '2026-07-05')],
      [],
      day('2026-06-28'), // last day of the older window
    );
    expect(merged.find((p) => p.start === '2026-06-22')?.current).toBe(true);
    expect(merged.find((p) => p.start === '2026-06-29')?.current).toBe(false);
  });
});
