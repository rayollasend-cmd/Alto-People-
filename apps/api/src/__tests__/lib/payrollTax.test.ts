import { describe, expect, it } from 'vitest';
import {
  FUTA_RATE_NET,
  FUTA_WAGE_BASE,
  MEDICARE_RATE,
  MEDICARE_SURCHARGE_RATE,
  MEDICARE_SURCHARGE_THRESHOLD,
  NO_SIT_STATES,
  SS_RATE,
  SS_WAGE_BASE_2024,
  computeEmployerTaxes,
  computeFederalIncomeTax,
  computeMedicare,
  computePaycheckTaxes,
  computeSocialSecurity,
  computeStateIncomeTax,
} from '../../lib/payrollTax.js';

const close = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;

describe('computeFederalIncomeTax (IRS Pub 15-T 2024 percentage method)', () => {
  it('zero-tax bracket: $200 biweekly single → $0 fed', () => {
    const w = computeFederalIncomeTax({
      grossPay: 200,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
    });
    expect(w).toBe(0);
  });

  it('mid-bracket single biweekly: $2000 biweekly ≈ annualized $52000', () => {
    // Annual $52000 → bracket "over 17600 flat $1160 + 12% of overage".
    // Excess: 52000 - 17600 = 34400; 34400*0.12 = 4128; +1160 = 5288 annual.
    // Per cycle: 5288/26 ≈ 203.38.
    const w = computeFederalIncomeTax({
      grossPay: 2000,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
    });
    expect(close(w, 203.38, 0.05)).toBe(true);
  });

  it('MFJ pays less than SINGLE on the same paycheck', () => {
    const single = computeFederalIncomeTax({
      grossPay: 3000,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
    });
    const mfj = computeFederalIncomeTax({
      grossPay: 3000,
      filingStatus: 'MARRIED_FILING_JOINTLY',
      payFrequency: 'BIWEEKLY',
    });
    expect(mfj).toBeLessThan(single);
  });

  it('extraWithholding line 4(c) adds verbatim per cycle', () => {
    const base = computeFederalIncomeTax({
      grossPay: 1500,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
    });
    const withExtra = computeFederalIncomeTax({
      grossPay: 1500,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
      extraWithholding: 50,
    });
    expect(close(withExtra - base, 50)).toBe(true);
  });

  it('dependents credit reduces withholding, never below zero', () => {
    const w = computeFederalIncomeTax({
      grossPay: 800,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
      dependentsAmount: 100_000, // huge credit
    });
    expect(w).toBe(0);
  });

  it('null filing status defaults to SINGLE', () => {
    const w1 = computeFederalIncomeTax({
      grossPay: 2000,
      filingStatus: null,
      payFrequency: 'BIWEEKLY',
    });
    const w2 = computeFederalIncomeTax({
      grossPay: 2000,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
    });
    expect(w1).toBe(w2);
  });
});

describe('computeSocialSecurity (FICA)', () => {
  it('charges 6.2% under the wage base', () => {
    const ss = computeSocialSecurity({ grossPay: 5000, ytdWages: 0 });
    expect(close(ss, 5000 * SS_RATE)).toBe(true);
  });

  it('caps at the SS wage base ($168,600 in 2024)', () => {
    // Already at the cap → no FICA owed on this paycheck.
    const ss = computeSocialSecurity({ grossPay: 5000, ytdWages: SS_WAGE_BASE_2024 });
    expect(ss).toBe(0);
  });

  it('partial cap when this paycheck crosses the threshold', () => {
    // 1000 of headroom remaining before the cap; this paycheck is 5000.
    const ss = computeSocialSecurity({
      grossPay: 5000,
      ytdWages: SS_WAGE_BASE_2024 - 1000,
    });
    expect(close(ss, 1000 * SS_RATE)).toBe(true);
  });
});

describe('computeMedicare', () => {
  it('charges 1.45% with no cap', () => {
    const m = computeMedicare({ grossPay: 10_000, ytdMedicareWages: 50_000 });
    expect(close(m, 10_000 * MEDICARE_RATE)).toBe(true);
  });

  it('adds 0.9% surcharge on the portion above $200k YTD', () => {
    // YTD before this check: $195k. This check: $10k. Portion over $200k = $5k.
    const m = computeMedicare({ grossPay: 10_000, ytdMedicareWages: 195_000 });
    const expected = 10_000 * MEDICARE_RATE + 5_000 * MEDICARE_SURCHARGE_RATE;
    expect(close(m, expected)).toBe(true);
  });

  it('surcharge applies to the entire paycheck once over the threshold', () => {
    const m = computeMedicare({ grossPay: 5_000, ytdMedicareWages: 250_000 });
    const expected = 5_000 * MEDICARE_RATE + 5_000 * MEDICARE_SURCHARGE_RATE;
    expect(close(m, expected)).toBe(true);
  });

  it('threshold constant is $200,000 (matches IRC §3101(b)(2))', () => {
    expect(MEDICARE_SURCHARGE_THRESHOLD).toBe(200_000);
  });
});

describe('computeStateIncomeTax', () => {
  it('returns 0 for every no-SIT state', () => {
    for (const s of NO_SIT_STATES) {
      const t = computeStateIncomeTax({ grossPay: 5000, state: s, payFrequency: 'BIWEEKLY' });
      expect(t).toBe(0);
    }
  });

  it('uses real CA brackets — $4000 biweekly ≈ annualized $104k', () => {
    const t = computeStateIncomeTax({ grossPay: 4000, state: 'CA', payFrequency: 'BIWEEKLY' });
    // CA bracket at $104k for single: over 70606 flat 3419.57 + 10.23%.
    // Excess: 104000 - 70606 = 33394; *.1023 = 3416.21; +3419.57 = 6835.78 annual.
    // Per cycle: 6835.78/26 ≈ 262.91.
    expect(close(t, 262.91, 0.5)).toBe(true);
  });

  it('uses real NY brackets — $2000 biweekly ≈ annualized $52k', () => {
    const t = computeStateIncomeTax({ grossPay: 2000, state: 'NY', payFrequency: 'BIWEEKLY' });
    // NY bracket at $52k for single: over 13900 flat 599.5 + 5.5%.
    // Excess: 52000 - 13900 = 38100; *.055 = 2095.5; +599.5 = 2695 annual.
    // Per cycle: 2695/26 ≈ 103.65.
    expect(close(t, 103.65, 0.2)).toBe(true);
  });

  it('falls back to flat 4% for unknown states', () => {
    const t = computeStateIncomeTax({ grossPay: 1000, state: 'IL', payFrequency: 'BIWEEKLY' });
    expect(close(t, 40)).toBe(true);
  });

  it('handles null state via fallback flat rate', () => {
    const t = computeStateIncomeTax({ grossPay: 1000, state: null, payFrequency: 'BIWEEKLY' });
    expect(close(t, 40)).toBe(true);
  });

  it('treats lowercase state codes correctly', () => {
    const t = computeStateIncomeTax({ grossPay: 1000, state: 'tx', payFrequency: 'BIWEEKLY' });
    expect(t).toBe(0);
  });
});

describe('computeEmployerTaxes', () => {
  it('FICA match equals employee FICA (under cap)', () => {
    const employee = computeSocialSecurity({ grossPay: 5000, ytdWages: 0 });
    const emp = computeEmployerTaxes({ grossPay: 5000, ytdWages: 0, ytdMedicareWages: 0 });
    expect(close(emp.fica, employee)).toBe(true);
  });

  it('Medicare match is 1.45% (no surcharge — that is employee-only)', () => {
    const emp = computeEmployerTaxes({ grossPay: 10_000, ytdWages: 0, ytdMedicareWages: 250_000 });
    expect(close(emp.medicare, 10_000 * MEDICARE_RATE)).toBe(true);
  });

  it('FUTA: 0.6% on the portion of YTD wages under $7000', () => {
    // First paycheck of the year, $3000.
    const emp = computeEmployerTaxes({ grossPay: 3000, ytdWages: 0, ytdMedicareWages: 0 });
    expect(close(emp.futa, 3000 * FUTA_RATE_NET)).toBe(true);
    expect(FUTA_WAGE_BASE).toBe(7_000);
  });

  it('FUTA caps at the wage base — second paycheck after exhausting $7k owes $0', () => {
    const emp = computeEmployerTaxes({ grossPay: 5000, ytdWages: 7000, ytdMedicareWages: 7000 });
    expect(emp.futa).toBe(0);
  });
});

describe('computePaycheckTaxes (aggregate)', () => {
  it('netPay = gross - (fed + ss + medicare + sit) and equals sum of components', () => {
    const out = computePaycheckTaxes({
      grossPay: 2500,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
      state: 'CA',
      ytdWages: 50_000,
      ytdMedicareWages: 50_000,
    });
    const sum = out.federalIncomeTax + out.socialSecurity + out.medicare + out.stateIncomeTax;
    expect(close(out.totalEmployeeTax, sum)).toBe(true);
    expect(close(out.netPay, 2500 - out.totalEmployeeTax)).toBe(true);
  });

  it('a Florida $1500 biweekly check has zero state tax', () => {
    const out = computePaycheckTaxes({
      grossPay: 1500,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
      state: 'FL',
      ytdWages: 0,
      ytdMedicareWages: 0,
    });
    expect(out.stateIncomeTax).toBe(0);
  });
});
