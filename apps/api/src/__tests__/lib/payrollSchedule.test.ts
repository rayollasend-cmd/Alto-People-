import { describe, expect, it } from 'vitest';
import {
  getCurrentPeriod,
  getNextPeriod,
  payPeriodsPerYear,
} from '../../lib/payrollSchedule.js';

const day = (s: string) => new Date(`${s}T12:00:00Z`);

describe('payPeriodsPerYear (IRS Pub 15-T multipliers)', () => {
  it('matches the IRS percentage-method denominators', () => {
    expect(payPeriodsPerYear('WEEKLY')).toBe(52);
    expect(payPeriodsPerYear('BIWEEKLY')).toBe(26);
    expect(payPeriodsPerYear('SEMIMONTHLY')).toBe(24);
    expect(payPeriodsPerYear('MONTHLY')).toBe(12);
  });
});

describe('getCurrentPeriod — WEEKLY', () => {
  const schedule = {
    frequency: 'WEEKLY' as const,
    anchorDate: '2026-01-05', // Monday
    payDateOffsetDays: 5,
  };

  it('returns the cycle containing today (Wednesday in week 1)', () => {
    const w = getCurrentPeriod(schedule, day('2026-01-07'));
    expect(w.periodStart).toBe('2026-01-05');
    expect(w.periodEnd).toBe('2026-01-11');
    expect(w.payDate).toBe('2026-01-16');
  });

  it('rolls into the next cycle once we cross the boundary', () => {
    const w = getCurrentPeriod(schedule, day('2026-01-12'));
    expect(w.periodStart).toBe('2026-01-12');
    expect(w.periodEnd).toBe('2026-01-18');
  });

  it('handles dates BEFORE the anchor (negative cyclesPassed)', () => {
    const w = getCurrentPeriod(schedule, day('2026-01-01'));
    expect(w.periodStart).toBe('2025-12-29');
    expect(w.periodEnd).toBe('2026-01-04');
  });
});

describe('getCurrentPeriod — BIWEEKLY', () => {
  const schedule = {
    frequency: 'BIWEEKLY' as const,
    anchorDate: '2026-01-05',
    payDateOffsetDays: 7,
  };

  it('uses a 14-day cycle from the anchor', () => {
    const w = getCurrentPeriod(schedule, day('2026-01-10'));
    expect(w.periodStart).toBe('2026-01-05');
    expect(w.periodEnd).toBe('2026-01-18');
    expect(w.payDate).toBe('2026-01-25');
  });

  it('advances to cycle 2 on day 15', () => {
    const w = getCurrentPeriod(schedule, day('2026-01-19'));
    expect(w.periodStart).toBe('2026-01-19');
    expect(w.periodEnd).toBe('2026-02-01');
  });
});

describe('getCurrentPeriod — SEMIMONTHLY', () => {
  const schedule = {
    frequency: 'SEMIMONTHLY' as const,
    anchorDate: '2026-01-01',
    payDateOffsetDays: 3,
  };

  it('returns 1st-15th for any day ≤ 15', () => {
    const w = getCurrentPeriod(schedule, day('2026-03-10'));
    expect(w.periodStart).toBe('2026-03-01');
    expect(w.periodEnd).toBe('2026-03-15');
    expect(w.payDate).toBe('2026-03-18');
  });

  it('returns 16th-EOM for any day ≥ 16', () => {
    const w = getCurrentPeriod(schedule, day('2026-03-20'));
    expect(w.periodStart).toBe('2026-03-16');
    expect(w.periodEnd).toBe('2026-03-31');
  });

  it('honors February 28 for non-leap years', () => {
    const w = getCurrentPeriod(schedule, day('2026-02-28'));
    expect(w.periodStart).toBe('2026-02-16');
    expect(w.periodEnd).toBe('2026-02-28');
  });

  it('honors February 29 in leap years', () => {
    const w = getCurrentPeriod(schedule, day('2024-02-29'));
    expect(w.periodEnd).toBe('2024-02-29');
  });
});

describe('getCurrentPeriod — MONTHLY', () => {
  const schedule = {
    frequency: 'MONTHLY' as const,
    anchorDate: '2026-01-01',
    payDateOffsetDays: 5,
  };

  it('returns the calendar month containing today', () => {
    const w = getCurrentPeriod(schedule, day('2026-04-15'));
    expect(w.periodStart).toBe('2026-04-01');
    expect(w.periodEnd).toBe('2026-04-30');
    expect(w.payDate).toBe('2026-05-05');
  });

  it('handles 31-day months', () => {
    const w = getCurrentPeriod(schedule, day('2026-07-15'));
    expect(w.periodEnd).toBe('2026-07-31');
  });
});

describe('getNextPeriod', () => {
  it('returns the cycle immediately after the current one (BIWEEKLY)', () => {
    const schedule = {
      frequency: 'BIWEEKLY' as const,
      anchorDate: '2026-01-05',
      payDateOffsetDays: 7,
    };
    const cur = getCurrentPeriod(schedule, day('2026-01-10'));
    const next = getNextPeriod(schedule, day('2026-01-10'));
    expect(next.periodStart).toBe('2026-01-19');
    // periodEnd of current + 1 day = periodStart of next
    expect(cur.periodEnd).toBe('2026-01-18');
  });

  it('crosses the half-month boundary (SEMIMONTHLY)', () => {
    const schedule = {
      frequency: 'SEMIMONTHLY' as const,
      anchorDate: '2026-01-01',
      payDateOffsetDays: 0,
    };
    const next = getNextPeriod(schedule, day('2026-03-10'));
    expect(next.periodStart).toBe('2026-03-16');
  });

  it('rolls into the next month from the second half', () => {
    const schedule = {
      frequency: 'SEMIMONTHLY' as const,
      anchorDate: '2026-01-01',
      payDateOffsetDays: 0,
    };
    const next = getNextPeriod(schedule, day('2026-03-25'));
    expect(next.periodStart).toBe('2026-04-01');
    expect(next.periodEnd).toBe('2026-04-15');
  });
});

describe('payDateOffsetDays', () => {
  it('zero offset → payDate equals periodEnd', () => {
    const w = getCurrentPeriod(
      {
        frequency: 'WEEKLY',
        anchorDate: '2026-01-05',
        payDateOffsetDays: 0,
      },
      day('2026-01-07')
    );
    expect(w.payDate).toBe(w.periodEnd);
  });

  it('crosses month boundaries cleanly', () => {
    const w = getCurrentPeriod(
      {
        frequency: 'MONTHLY',
        anchorDate: '2026-01-01',
        payDateOffsetDays: 5,
      },
      day('2026-01-15')
    );
    expect(w.periodEnd).toBe('2026-01-31');
    expect(w.payDate).toBe('2026-02-05');
  });
});
