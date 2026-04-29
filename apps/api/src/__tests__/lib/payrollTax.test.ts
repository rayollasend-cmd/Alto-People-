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
  isStateTaxSupported,
  zeroTaxBreakdown,
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
    // AR has no real table yet (not in NO_SIT, not flat-rate, not bracketed) → fallback fires.
    const t = computeStateIncomeTax({ grossPay: 1000, state: 'AR', payFrequency: 'BIWEEKLY' });
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

describe('Wave 2 — additional bracket states (NJ/GA/OH/VA/MN)', () => {
  it('NJ uses progressive brackets — $2000 biweekly ≈ annualized $52k', () => {
    const t = computeStateIncomeTax({ grossPay: 2000, state: 'NJ', payFrequency: 'BIWEEKLY' });
    // Annual $52000 → bracket "over 40000 flat 717.5 + 5.525%".
    // Excess: 52000 - 40000 = 12000; *.05525 = 663; +717.5 = 1380.5 annual.
    // Per cycle: 1380.5/26 ≈ 53.10.
    expect(close(t, 53.10, 0.5)).toBe(true);
  });

  it('GA applies a flat top rate of 5.39% (HB 1437 phased reduction)', () => {
    const t = computeStateIncomeTax({ grossPay: 2000, state: 'GA', payFrequency: 'BIWEEKLY' });
    // Annual $52000 × 5.39% = 2802.80; per cycle 2802.80/26 ≈ 107.80.
    expect(close(t, 107.80, 0.5)).toBe(true);
  });

  it('OH zero-tax bracket below $26,050 annualized', () => {
    const t = computeStateIncomeTax({ grossPay: 800, state: 'OH', payFrequency: 'BIWEEKLY' });
    // Annual $20800 < 26050 standard exemption → 0 tax.
    expect(t).toBe(0);
  });

  it('VA progressive brackets — $1500 biweekly ≈ annualized $39k', () => {
    const t = computeStateIncomeTax({ grossPay: 1500, state: 'VA', payFrequency: 'BIWEEKLY' });
    // Annual $39000 → bracket "over 17000 flat 720 + 5.75%".
    // Excess: 39000 - 17000 = 22000; *.0575 = 1265; +720 = 1985 annual.
    // Per cycle: 1985/26 ≈ 76.35.
    expect(close(t, 76.35, 0.5)).toBe(true);
  });

  it('MN progressive brackets — $2500 biweekly ≈ annualized $65k', () => {
    const t = computeStateIncomeTax({ grossPay: 2500, state: 'MN', payFrequency: 'BIWEEKLY' });
    // Annual $65000 → bracket "over 31690 flat 1695.42 + 6.8%".
    // Excess: 65000 - 31690 = 33310; *.068 = 2265.08; +1695.42 = 3960.50 annual.
    // Per cycle: 3960.50/26 ≈ 152.33.
    expect(close(t, 152.33, 0.5)).toBe(true);
  });
});

describe('Wave 2 — flat-rate states', () => {
  it('IL applies 4.95%', () => {
    const t = computeStateIncomeTax({ grossPay: 1000, state: 'IL', payFrequency: 'BIWEEKLY' });
    expect(close(t, 49.50)).toBe(true);
  });

  it('PA applies 3.07%', () => {
    const t = computeStateIncomeTax({ grossPay: 1000, state: 'PA', payFrequency: 'BIWEEKLY' });
    expect(close(t, 30.70)).toBe(true);
  });

  it('AZ applies 2.5% (post-2023 flat rate)', () => {
    const t = computeStateIncomeTax({ grossPay: 1000, state: 'AZ', payFrequency: 'BIWEEKLY' });
    expect(close(t, 25.00)).toBe(true);
  });

  it('flat-rate states ignore payFrequency (no annualization needed)', () => {
    const biweekly = computeStateIncomeTax({ grossPay: 1000, state: 'CO', payFrequency: 'BIWEEKLY' });
    const monthly = computeStateIncomeTax({ grossPay: 1000, state: 'CO', payFrequency: 'MONTHLY' });
    expect(biweekly).toBe(monthly);
  });
});

describe('isStateTaxSupported', () => {
  it('returns true for NO_SIT states (TX, FL, etc.)', () => {
    expect(isStateTaxSupported('TX')).toBe(true);
    expect(isStateTaxSupported('FL')).toBe(true);
    expect(isStateTaxSupported('NV')).toBe(true);
  });

  it('returns true for bracketed states (CA, NY, NJ, GA, OH, VA, MN)', () => {
    expect(isStateTaxSupported('CA')).toBe(true);
    expect(isStateTaxSupported('NY')).toBe(true);
    expect(isStateTaxSupported('NJ')).toBe(true);
    expect(isStateTaxSupported('GA')).toBe(true);
    expect(isStateTaxSupported('OH')).toBe(true);
    expect(isStateTaxSupported('VA')).toBe(true);
    expect(isStateTaxSupported('MN')).toBe(true);
  });

  it('returns true for flat-rate states (IL, PA, MI, etc.)', () => {
    expect(isStateTaxSupported('IL')).toBe(true);
    expect(isStateTaxSupported('PA')).toBe(true);
    expect(isStateTaxSupported('MI')).toBe(true);
    expect(isStateTaxSupported('NC')).toBe(true);
  });

  it('returns false for the long tail (AR, HI, MS, MT, etc.)', () => {
    expect(isStateTaxSupported('AR')).toBe(false);
    expect(isStateTaxSupported('HI')).toBe(false);
    expect(isStateTaxSupported('MS')).toBe(false);
    expect(isStateTaxSupported('MT')).toBe(false);
  });

  it('returns false for null and empty string', () => {
    expect(isStateTaxSupported(null)).toBe(false);
    expect(isStateTaxSupported('')).toBe(false);
  });

  it('handles lowercase input', () => {
    expect(isStateTaxSupported('ca')).toBe(true);
    expect(isStateTaxSupported('tx')).toBe(true);
  });
});

describe('Wave 2.3 — per-state SUTA wage base + rate', () => {
  it('CA SUTA: 3.4% on first $7000 of YTD wages', () => {
    // First paycheck of the year, $5000 — entirely under the $7k base.
    const emp = computeEmployerTaxes({ grossPay: 5000, ytdWages: 0, ytdMedicareWages: 0, state: 'CA' });
    expect(close(emp.suta, 5000 * 0.034)).toBe(true);
  });

  it('CA SUTA caps at $7000 wage base (next paycheck owes 0)', () => {
    const emp = computeEmployerTaxes({ grossPay: 5000, ytdWages: 7000, ytdMedicareWages: 7000, state: 'CA' });
    expect(emp.suta).toBe(0);
  });

  it('WA SUTA uses a much higher wage base ($68,500) and 1.14% rate', () => {
    const emp = computeEmployerTaxes({ grossPay: 5000, ytdWages: 30_000, ytdMedicareWages: 30_000, state: 'WA' });
    expect(close(emp.suta, 5000 * 0.0114)).toBe(true);
  });

  it('NY SUTA: 4.1% on first $12,500', () => {
    const emp = computeEmployerTaxes({ grossPay: 4000, ytdWages: 0, ytdMedicareWages: 0, state: 'NY' });
    expect(close(emp.suta, 4000 * 0.041)).toBe(true);
  });

  it('partial cap when this paycheck crosses the SUTA wage base', () => {
    // CA wage base $7000. YTD $5000 → $2000 headroom remaining for a $5000 check.
    const emp = computeEmployerTaxes({ grossPay: 5000, ytdWages: 5000, ytdMedicareWages: 5000, state: 'CA' });
    expect(close(emp.suta, 2000 * 0.034)).toBe(true);
  });

  it('unknown / missing state falls back to FUTA wage base + 2.7% rate', () => {
    const emp = computeEmployerTaxes({ grossPay: 3000, ytdWages: 0, ytdMedicareWages: 0, state: null });
    expect(close(emp.suta, 3000 * 0.027)).toBe(true);
  });

  it('uppercases state code before lookup', () => {
    const upper = computeEmployerTaxes({ grossPay: 4000, ytdWages: 0, ytdMedicareWages: 0, state: 'CA' });
    const lower = computeEmployerTaxes({ grossPay: 4000, ytdWages: 0, ytdMedicareWages: 0, state: 'ca' });
    expect(lower.suta).toBe(upper.suta);
  });
});

describe('zeroTaxBreakdown — 1099 contractors', () => {
  it('returns all zeros except netPay = grossPay', () => {
    const z = zeroTaxBreakdown(2500);
    expect(z.federalIncomeTax).toBe(0);
    expect(z.socialSecurity).toBe(0);
    expect(z.medicare).toBe(0);
    expect(z.stateIncomeTax).toBe(0);
    expect(z.totalEmployeeTax).toBe(0);
    expect(z.netPay).toBe(2500);
  });

  it('zeros out employer-side taxes too (no FICA/FUTA/SUTA owed on 1099)', () => {
    const z = zeroTaxBreakdown(2500);
    expect(z.employer.fica).toBe(0);
    expect(z.employer.medicare).toBe(0);
    expect(z.employer.futa).toBe(0);
    expect(z.employer.suta).toBe(0);
  });
});
