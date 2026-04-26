import { describe, expect, it } from 'vitest';
import {
  computeFederalWithholding,
  computeNet,
  msToHours,
  pickHourlyRate,
  round2,
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
