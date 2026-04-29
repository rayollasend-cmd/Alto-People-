import { describe, expect, it } from 'vitest';
import {
  computeFederalWithholding,
  computeNet,
  msToHours,
  pickHourlyRate,
  round2,
  splitWeeklyOvertime,
  sumApprovedHours,
} from '../../lib/payroll.js';

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(1.004)).toBe(1.0);
    expect(round2(0)).toBe(0);
  });
});

describe('msToHours', () => {
  it('converts ms → hours with 2 decimal precision', () => {
    expect(msToHours(60 * 60 * 1000)).toBe(1);
    expect(msToHours(90 * 60 * 1000)).toBe(1.5);
    expect(msToHours(0)).toBe(0);
  });
});

describe('computeFederalWithholding (placeholder formula)', () => {
  it('SINGLE bracket = 18%', () => {
    expect(
      computeFederalWithholding({ grossPay: 100, filingStatus: 'SINGLE' })
    ).toBe(18);
  });

  it('MARRIED_FILING_JOINTLY bracket = 14%', () => {
    expect(
      computeFederalWithholding({ grossPay: 100, filingStatus: 'MARRIED_FILING_JOINTLY' })
    ).toBe(14);
  });

  it('HEAD_OF_HOUSEHOLD bracket = 16%', () => {
    expect(
      computeFederalWithholding({ grossPay: 100, filingStatus: 'HEAD_OF_HOUSEHOLD' })
    ).toBe(16);
  });

  it('null filing status defaults to SINGLE', () => {
    expect(
      computeFederalWithholding({ grossPay: 100, filingStatus: null })
    ).toBe(18);
  });

  it('adds extraWithholding from W-4 line 4(c)', () => {
    expect(
      computeFederalWithholding({
        grossPay: 100,
        filingStatus: 'SINGLE',
        extraWithholding: 25,
      })
    ).toBe(43);
  });

  it('treats negative extraWithholding as 0 (defensive)', () => {
    expect(
      computeFederalWithholding({
        grossPay: 100,
        filingStatus: 'SINGLE',
        extraWithholding: -10,
      })
    ).toBe(18);
  });
});

describe('computeNet', () => {
  it('subtracts withholding from gross', () => {
    expect(computeNet(100, 18)).toBe(82);
    expect(computeNet(50, 0)).toBe(50);
  });
});

describe('sumApprovedHours', () => {
  const t = (h: number, m = 0) => new Date(2026, 0, 1, h, m);

  it('returns 0 for an empty list', () => {
    expect(sumApprovedHours([])).toBe(0);
  });

  it('only counts APPROVED with both clock-in and clock-out', () => {
    const entries = [
      { status: 'APPROVED', clockInAt: t(9), clockOutAt: t(17) },         // 8h
      { status: 'APPROVED', clockInAt: t(8), clockOutAt: t(8, 30) },      // 0.5h
      { status: 'COMPLETED', clockInAt: t(8), clockOutAt: t(16) },        // ignored
      { status: 'REJECTED', clockInAt: t(8), clockOutAt: t(16) },         // ignored
      { status: 'ACTIVE', clockInAt: t(8), clockOutAt: null },            // ignored
    ];
    expect(sumApprovedHours(entries)).toBe(8.5);
  });
});

describe('pickHourlyRate', () => {
  it('returns default when no shifts have a rate', () => {
    expect(pickHourlyRate([{ hourlyRate: null }, { hourlyRate: null }], 15)).toBe(15);
  });

  it('returns the highest rate among shifts (defensible MVP choice)', () => {
    const shifts = [
      { hourlyRate: { toString: () => '18.50' } as never },
      { hourlyRate: { toString: () => '20.00' } as never },
      { hourlyRate: null },
    ];
    expect(pickHourlyRate(shifts, 15)).toBe(20);
  });

  it('returns default when default exceeds all shift rates', () => {
    const shifts = [{ hourlyRate: { toString: () => '10.00' } as never }];
    expect(pickHourlyRate(shifts, 25)).toBe(25);
  });
});

describe('splitWeeklyOvertime — FLSA weekly OT (40h/week threshold)', () => {
  // Helper: build an APPROVED entry of `hours` starting at clockIn.
  const e = (clockIn: Date, hours: number) => ({
    status: 'APPROVED',
    clockInAt: clockIn,
    clockOutAt: new Date(clockIn.getTime() + hours * 60 * 60 * 1000),
  });

  // 2026-01-05 is a Monday (UTC).
  const monday = (offsetDays = 0) =>
    new Date(Date.UTC(2026, 0, 5 + offsetDays, 9, 0));

  it('returns zeros for empty input', () => {
    expect(splitWeeklyOvertime([])).toEqual({ regularHours: 0, overtimeHours: 0 });
  });

  it('skips non-APPROVED and missing-clockOut entries', () => {
    const entries = [
      { status: 'ACTIVE', clockInAt: monday(), clockOutAt: null },
      { status: 'COMPLETED', clockInAt: monday(), clockOutAt: monday(1) },
      { status: 'REJECTED', clockInAt: monday(), clockOutAt: monday(1) },
    ];
    expect(splitWeeklyOvertime(entries)).toEqual({ regularHours: 0, overtimeHours: 0 });
  });

  it('under 40h in one week → all regular, zero OT', () => {
    // Mon-Thu, 8h/day = 32h.
    const entries = [
      e(monday(0), 8),
      e(monday(1), 8),
      e(monday(2), 8),
      e(monday(3), 8),
    ];
    const r = splitWeeklyOvertime(entries);
    expect(r.regularHours).toBe(32);
    expect(r.overtimeHours).toBe(0);
  });

  it('exactly 40h in one week → regular 40, OT 0', () => {
    const entries = [
      e(monday(0), 8),
      e(monday(1), 8),
      e(monday(2), 8),
      e(monday(3), 8),
      e(monday(4), 8),
    ];
    const r = splitWeeklyOvertime(entries);
    expect(r.regularHours).toBe(40);
    expect(r.overtimeHours).toBe(0);
  });

  it('45h in one week → 40 regular + 5 OT', () => {
    const entries = [
      e(monday(0), 9),
      e(monday(1), 9),
      e(monday(2), 9),
      e(monday(3), 9),
      e(monday(4), 9),
    ];
    const r = splitWeeklyOvertime(entries);
    expect(r.regularHours).toBe(40);
    expect(r.overtimeHours).toBe(5);
  });

  it('biweekly: 50h week 1 + 30h week 2 → 70 regular + 10 OT (per-week, not per-period)', () => {
    // The FLSA rule is per-workweek: a "slow" second week does NOT offset a
    // "heavy" first week. 50h week 1 = 40 reg + 10 OT. 30h week 2 = 30 reg.
    // Total: 70 reg, 10 OT.
    const entries = [
      e(monday(0), 10), e(monday(1), 10), e(monday(2), 10),
      e(monday(3), 10), e(monday(4), 10), // 50h week 1
      e(monday(7), 10), e(monday(8), 10), e(monday(9), 10), // 30h week 2
    ];
    const r = splitWeeklyOvertime(entries);
    expect(r.regularHours).toBe(70);
    expect(r.overtimeHours).toBe(10);
  });

  it('Sunday and Monday belong to different weeks (Mon-anchored UTC)', () => {
    // 2026-01-04 is a Sunday → belongs to the prior workweek (Dec 29 - Jan 4).
    // 2026-01-05 is a Monday → starts a new workweek.
    // 35h on Sun + 35h on Mon = neither week tops 40 → zero OT.
    const sunday = new Date(Date.UTC(2026, 0, 4, 0, 0));
    const entries = [e(sunday, 35), e(monday(0), 35)];
    const r = splitWeeklyOvertime(entries);
    expect(r.regularHours).toBe(70);
    expect(r.overtimeHours).toBe(0);
  });

  it('rounds outputs to 2 decimals', () => {
    // 40.333h → 40 reg + 0.33 OT (after round2).
    const entries = [e(monday(0), 40.333)];
    const r = splitWeeklyOvertime(entries);
    expect(r.regularHours).toBe(40);
    expect(r.overtimeHours).toBe(0.33);
  });
});
