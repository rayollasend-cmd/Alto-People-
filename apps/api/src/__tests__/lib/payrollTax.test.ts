import { beforeAll, describe, expect, it } from 'vitest';
import {
  FUTA_RATE_NET,
  FUTA_WAGE_BASE,
  MEDICARE_RATE,
  MEDICARE_SURCHARGE_RATE,
  MEDICARE_SURCHARGE_THRESHOLD,
  NO_SIT_STATES,
  SS_RATE,
  SS_WAGE_BASE,
  __setPayrollTaxConfigForTesting,
  computeEmployerTaxes,
  computeFederalIncomeTax,
  computeMedicare,
  computePaycheckTaxes,
  computeSocialSecurity,
  computeStateIncomeTax,
  isStateTaxSupported,
  supportedStates,
  zeroTaxBreakdown,
} from '../../lib/payrollTax.js';

const close = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;

// IRS Pub 15-T 2026, Worksheet 1A — Standard Withholding Rate Schedules
// (W-4 Step 2 NOT checked). Mirrors the row seeded by the
// add_payroll_config migration so prod and unit tests reason about the
// same numbers. If the migration's seeded brackets ever drift from these,
// payroll output diverges from prod — keep them in sync.
beforeAll(() => {
  __setPayrollTaxConfigForTesting({
    year: 2026,
    fedBrackets: {
      SINGLE: [
        { over: 0, flat: 0, rate: 0 },
        { over: 7_500, flat: 0, rate: 0.1 },
        { over: 19_900, flat: 1_240, rate: 0.12 },
        { over: 57_900, flat: 5_800, rate: 0.22 },
        { over: 113_200, flat: 17_966, rate: 0.24 },
        { over: 209_275, flat: 41_024, rate: 0.32 },
        { over: 263_725, flat: 58_448, rate: 0.35 },
        { over: 648_100, flat: 192_979.25, rate: 0.37 },
      ],
      MARRIED_FILING_JOINTLY: [
        { over: 0, flat: 0, rate: 0 },
        { over: 19_300, flat: 0, rate: 0.1 },
        { over: 44_100, flat: 2_480, rate: 0.12 },
        { over: 120_100, flat: 11_600, rate: 0.22 },
        { over: 230_700, flat: 35_932, rate: 0.24 },
        { over: 422_850, flat: 82_048, rate: 0.32 },
        { over: 531_750, flat: 116_896, rate: 0.35 },
        { over: 788_000, flat: 206_583.5, rate: 0.37 },
      ],
      HEAD_OF_HOUSEHOLD: [
        { over: 0, flat: 0, rate: 0 },
        { over: 15_550, flat: 0, rate: 0.1 },
        { over: 33_250, flat: 1_770, rate: 0.12 },
        { over: 83_000, flat: 7_740, rate: 0.22 },
        { over: 121_250, flat: 16_155, rate: 0.24 },
        { over: 217_300, flat: 39_207, rate: 0.32 },
        { over: 271_750, flat: 56_631, rate: 0.35 },
        { over: 656_150, flat: 191_171, rate: 0.37 },
      ],
    },
    ssWageBase: 184_500,
    medicareSurchargeThreshold: 200_000,
  });
});

describe('computeFederalIncomeTax (IRS Pub 15-T 2026 percentage method)', () => {
  it('zero-tax bracket: $200 biweekly single → $0 fed', () => {
    const w = computeFederalIncomeTax({
      grossPay: 200,
      filingStatus: 'SINGLE',
      payFrequency: 'BIWEEKLY',
    });
    expect(w).toBe(0);
  });

  it('Worksheet 1A: $2,000 biweekly Single = annual $52,000 less line 1g $8,600 → $156.15', () => {
    // 52,000 − 8,600 = 43,400; 1,240 + (43,400 − 19,900) × 12% = 4,060; ÷ 26 = 156.15.
    const w = computeFederalIncomeTax({ grossPay: 2000, filingStatus: 'SINGLE', payFrequency: 'BIWEEKLY' });
    expect(w).toBe(156.15);
  });

  // Pub 15-T (2026) §2 Wage Bracket table, BIWEEKLY, row "$1,985 – $2,005":
  // MFJ $76 / checkbox $156 · HOH $114 / checkbox $200 · Single $156 / checkbox $269.
  // The percentage method at the row's midpoint ($1,995) rounds to the same dollars.
  it.each([
    ['MARRIED_FILING_JOINTLY', false, 76],
    ['MARRIED_FILING_JOINTLY', true, 156],
    ['HEAD_OF_HOUSEHOLD', false, 114],
    ['HEAD_OF_HOUSEHOLD', true, 200],
    ['SINGLE', false, 156],
    ['SINGLE', true, 269],
  ] as const)('matches the published wage bracket table: %s, Step 2 checked = %s → $%i', (status, multipleJobs, dollars) => {
    const w = computeFederalIncomeTax({ grossPay: 1995, filingStatus: status, payFrequency: 'BIWEEKLY', multipleJobs });
    expect(Math.round(w)).toBe(dollars);
  });

  it('a 2019-or-earlier W-4 subtracts $4,300 per allowance and has no head-of-household table', () => {
    // $1,000 biweekly, 2 allowances: 26,000 − 8,600 = 17,400 → (17,400 − 7,500) × 10% = 990 ÷ 26 = 38.08.
    expect(computeFederalIncomeTax({ grossPay: 1000, filingStatus: 'SINGLE', payFrequency: 'BIWEEKLY', pre2020Allowances: 2 })).toBe(38.08);
    expect(computeFederalIncomeTax({ grossPay: 1000, filingStatus: 'HEAD_OF_HOUSEHOLD', payFrequency: 'BIWEEKLY', pre2020Allowances: 2 })).toBe(38.08);
  });

  it('nonresident alien: the Pub 15-T example ($300 weekly, 2019 W-4 Single, 1 allowance) withholds $31', () => {
    // Pub 15-T (2026) p. 6: $300 + Table 1 $226.90 = $526.90; the wage bracket table gives $31.
    const w = computeFederalIncomeTax({ grossPay: 300, filingStatus: 'SINGLE', payFrequency: 'WEEKLY', pre2020Allowances: 1, nonresidentAlien: true });
    expect(Math.round(w)).toBe(31);
    // A 2020+ W-4 adds Table 2 ($309.60 weekly) instead.
    const w2020 = computeFederalIncomeTax({ grossPay: 300, filingStatus: 'SINGLE', payFrequency: 'WEEKLY', nonresidentAlien: true });
    // (300 + 309.60) × 52 = 31,699.20 − 8,600 = 23,099.20 → 1,240 + 3,199.20 × 12% = 1,623.90 ÷ 52 = 31.23.
    expect(w2020).toBe(31.23);
  });

  it('an exempt W-4 withholds nothing, even the 4(c) extra', () => {
    expect(computeFederalIncomeTax({ grossPay: 5000, filingStatus: 'SINGLE', payFrequency: 'BIWEEKLY', extraWithholding: 50, exempt: true })).toBe(0);
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

  it('caps at the SS wage base ($184,500 in 2026)', () => {
    // Already at the cap → no FICA owed on this paycheck.
    const ss = computeSocialSecurity({ grossPay: 5000, ytdWages: SS_WAGE_BASE() });
    expect(ss).toBe(0);
  });

  it('partial cap when this paycheck crosses the threshold', () => {
    // 1000 of headroom remaining before the cap; this paycheck is 5000.
    const ss = computeSocialSecurity({
      grossPay: 5000,
      ytdWages: SS_WAGE_BASE() - 1000,
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
    expect(MEDICARE_SURCHARGE_THRESHOLD()).toBe(200_000);
  });
});

describe('computeStateIncomeTax', () => {
  it('returns 0 for every no-SIT state', () => {
    for (const s of NO_SIT_STATES) {
      const t = computeStateIncomeTax({ grossPay: 5000, state: s, payFrequency: 'BIWEEKLY' });
      expect(t).toBe(0);
    }
  });

  it('CA 2026 (DE 44 Method B): $4,000 biweekly single, no allowances → $236.08', () => {
    // 104,000 − 5,706 = 98,294 → 3,522.17 + 25,570 × 10.23% = 6,137.98 ÷ 26.
    expect(computeStateIncomeTax({ grossPay: 4000, state: 'CA', payFrequency: 'BIWEEKLY' })).toBe(236.08);
  });

  it('NY 2026 (NYS-50-T-NYS): $2,000 biweekly single → $86.30', () => {
    // 52,000 − 7,400 = 44,600 → 586 + 30,700 × 5.4% = 2,243.80 ÷ 26.
    expect(computeStateIncomeTax({ grossPay: 2000, state: 'NY', payFrequency: 'BIWEEKLY' })).toBe(86.3);
  });

  it('withholds nothing for an unsupported state — the run is blocked upstream, never guessed at 4%', () => {
    // PR has no table (every state and DC has one now; a new one waits on adviser review): no fallback.
    const t = computeStateIncomeTax({ grossPay: 1000, state: 'PR', payFrequency: 'BIWEEKLY' });
    expect(t).toBe(0);
    expect(isStateTaxSupported('PR')).toBe(false);
    expect(supportedStates()).toContain('CA');
    expect(supportedStates()).toContain('FL');
    expect(supportedStates()).not.toContain('AR');
  });

  it('withholds nothing with no state on file', () => {
    const t = computeStateIncomeTax({ grossPay: 1000, state: null, payFrequency: 'BIWEEKLY' });
    expect(t).toBe(0);
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
  it('NJ withholds at the NJ-WT Rate A table (single), not the tax rates: $2,000 biweekly → $58.73', () => {
    // 52,000: 20,000 × 1.5% + 15,000 × 2% + 5,000 × 3.9% + 12,000 × 6.1% = 1,527 ÷ 26.
    const t = computeStateIncomeTax({ grossPay: 2000, state: 'NJ', payFrequency: 'BIWEEKLY' });
    expect(t).toBe(58.73);
  });

  it('GA 2026: 4.99% after the $15,000 standard deduction (HB 463 / HB 1199)', () => {
    // (52,000 − 15,000) × 4.99% = 1,846.30 ÷ 26 = 71.01.
    const t = computeStateIncomeTax({ grossPay: 2000, state: 'GA', payFrequency: 'BIWEEKLY' });
    expect(t).toBe(71.01);
  });

  it('OH from August 1, 2026 withholds 1.6% below $26,050: $800 biweekly → $12.80', () => {
    expect(computeStateIncomeTax({ grossPay: 800, state: 'OH', payFrequency: 'BIWEEKLY' })).toBe(12.8);
  });

  it('VA 2026: $8,750 standard deduction, then 2/3/5/5.75%: $1,500 biweekly → $57.00', () => {
    // 39,000 − 8,750 = 30,250 → 60 + 60 + 600 + 13,250 × 5.75% = 1,481.88 ÷ 26.
    const t = computeStateIncomeTax({ grossPay: 1500, state: 'VA', payFrequency: 'BIWEEKLY' });
    expect(t).toBe(57);
  });

  it('MN 2026 computer formula: $2,500 biweekly, no allowances → $139.13', () => {
    // 65,000 → 1,782.09 + 26,990 × 6.8% = 3,617.41 ÷ 26.
    expect(computeStateIncomeTax({ grossPay: 2500, state: 'MN', payFrequency: 'BIWEEKLY' })).toBe(139.13);
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

  it('AZ withholds the A-4 default 2.0% with no election on file, the elected rate otherwise', () => {
    expect(computeStateIncomeTax({ grossPay: 1000, state: 'AZ', payFrequency: 'BIWEEKLY' })).toBe(20);
    const elected = computeStateIncomeTax({ grossPay: 1000, state: 'AZ', payFrequency: 'BIWEEKLY', stateW4: { filingStatus: 'SINGLE', allowances: 35, dependents: 0, additionalWithholding: 0, exempt: false } });
    expect(elected).toBe(35);
  });

  it('CO 2026 subtracts its annual allowance before 4.4% (DR 1098): $1,000 biweekly → $34.69', () => {
    // (26,000 − 5,500) × 4.4% = 902 ÷ 26.
    expect(computeStateIncomeTax({ grossPay: 1000, state: 'CO', payFrequency: 'BIWEEKLY' })).toBe(34.69);
  });

  it('KY 2026 worked example from the DOR formula: $3,270 monthly → $104.65', () => {
    expect(computeStateIncomeTax({ grossPay: 3270, state: 'KY', payFrequency: 'MONTHLY' })).toBe(104.65);
  });

  it('IL 2026: 4.95% after $2,925 per Line 1 allowance and $1,000 per Line 2', () => {
    // 2,000 × 26 = 52,000 − 2,925 − 1,000 = 48,075 × 4.95% = 2,379.71 ÷ 26 = 91.53.
    const t = computeStateIncomeTax({ grossPay: 2000, state: 'IL', payFrequency: 'BIWEEKLY', stateW4: { filingStatus: 'SINGLE', allowances: 1, dependents: 1, additionalWithholding: 0, exempt: false } });
    expect(t).toBe(91.53);
  });

  it('MI 2026: 4.25% after $5,900 per exemption; PA flat 3.07%', () => {
    const mi = computeStateIncomeTax({ grossPay: 2000, state: 'MI', payFrequency: 'BIWEEKLY', stateW4: { filingStatus: 'SINGLE', allowances: 1, dependents: 0, additionalWithholding: 0, exempt: false } });
    expect(mi).toBe(75.36); // (52,000 − 5,900) × 4.25% = 1,959.25 ÷ 26
    expect(computeStateIncomeTax({ grossPay: 2000, state: 'PA', payFrequency: 'BIWEEKLY' })).toBe(61.4);
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

  it('returns false for the states still awaiting review (AR, WI, MS, MT, etc.)', () => {
    expect(isStateTaxSupported('AR')).toBe(false);
    expect(isStateTaxSupported('WI')).toBe(false);
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

describe('federal W-4 rules and supplemental wages (Pub 15 §7, §9)', () => {
  it('supplemental wages: 22% up to $1M in the year, 37% on the part over', async () => {
    const { supplementalFederalWithholding } = await import('../../lib/payrollTax.js');
    expect(supplementalFederalWithholding(10_000, 0)).toBe(2200);
    // $990,000 already paid this year: $10,000 at 22% and $15,000 at 37%.
    expect(supplementalFederalWithholding(25_000, 990_000)).toBe(2200 + 5550);
  });

  it('an Exempt W-4 lapses after February 15 of the next year: Single, no adjustments', async () => {
    const { federalW4Fields } = await import('../../lib/payrollTax.js');
    const w4 = { filingStatus: 'MARRIED_FILING_JOINTLY' as const, exempt: true, exemptTaxYear: 2025, dependentsAmount: 4000, extraWithholding: 20 };
    expect(federalW4Fields(w4, new Date('2026-02-13T12:00:00Z'))!.exempt).toBe(true);
    const lapsed = federalW4Fields(w4, new Date('2026-02-20T12:00:00Z'))!;
    expect(lapsed).toMatchObject({ exempt: false, filingStatus: 'SINGLE', dependentsAmount: 0, extraWithholding: 0 });
    expect(lapsed.flags).toContain('EXEMPT_EXPIRED');
  });

  it('an IRS lock-in letter sets the status and ignores reductions; increases still apply', async () => {
    const { federalW4Fields } = await import('../../lib/payrollTax.js');
    const w4 = { filingStatus: 'MARRIED_FILING_JOINTLY' as const, dependentsAmount: 4000, deductions: 10_000, extraWithholding: 25, lockInFilingStatus: 'SINGLE' as const, lockInMultipleJobs: false, lockInEffectiveDate: '2026-03-01' };
    expect(federalW4Fields(w4, new Date('2026-02-15T12:00:00Z'))!.filingStatus).toBe('MARRIED_FILING_JOINTLY');
    const locked = federalW4Fields(w4, new Date('2026-03-06T12:00:00Z'))!;
    expect(locked).toMatchObject({ filingStatus: 'SINGLE', dependentsAmount: 0, deductions: 0, extraWithholding: 25 });
    expect(locked.flags).toContain('LOCK_IN_LETTER');
  });

  it('FUTA: 0.6% plus the credit reduction where one applies (CA, 2026 potential 1.5%)', async () => {
    const { futaCreditReduction } = await import('../../lib/payrollTax.js');
    expect(futaCreditReduction('CA', 2025)).toBe(0.012);
    expect(futaCreditReduction('CA', 2026)).toBe(0.015);
    expect(futaCreditReduction('FL', 2026)).toBe(0);
    const fl = computeEmployerTaxes({ grossPay: 1000, ytdWages: 0, ytdMedicareWages: 0, state: 'FL' });
    const ca = computeEmployerTaxes({ grossPay: 1000, ytdWages: 0, ytdMedicareWages: 0, state: 'CA' });
    expect(fl.futa).toBe(6);
    expect(ca.futa).toBe(21);
  });
});
