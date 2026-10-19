import { describe, expect, it } from 'vitest';
import { VERIFIED_STATE_SPECS } from '../../lib/stateWithholding2026.js';
import { STATE_SPECS, type StateCalcInput } from '../../lib/stateWithholding.js';
import { calculateInHouse } from '../../lib/taxEngine/index.js';

/**
 * 2026 state withholding, each against the worked example its agency
 * publishes (cited beside it), or the agency's own formula worked by hand.
 * Annual figures; the engine divides by pay periods.
 */

const spec = (s: string) => VERIFIED_STATE_SPECS[s]!;
const base = (o: Partial<StateCalcInput>): StateCalcInput => ({ annualWages: 0, filingStatus: 'SINGLE', allowances: 0, dependents: 0, annualFederalWithholding: 0, hasCertificate: true, ...o });

describe('2026 methods, against the agencies’ worked examples', () => {
  it('CA (DE 44 2026, Method B examples E and F)', () => {
    // E: semi-monthly $2,400, married, 4 allowances → annual $99.20 ÷ 24 = $4.13.
    expect(spec('CA').annualTax(base({ annualWages: 57_600, filingStatus: 'MARRIED', allowances: 4 }))).toBeCloseTo(99.2, 2);
    // F: $57,000 a year, married, 4 allowances → $86.00 (÷ 12 = $7.17).
    expect(spec('CA').annualTax(base({ annualWages: 57_000, filingStatus: 'MARRIED', allowances: 4 }))).toBeCloseTo(86, 2);
    // Example A: under the low-income exemption, nothing is withheld.
    expect(spec('CA').annualTax(base({ annualWages: 210 * 52, allowances: 1 }))).toBe(0);
  });

  it('NY State (NYS-50-T-NYS 2026, Method II examples 1 and 2, annualized)', () => {
    // Example 2: semimonthly $5,000, single, 1 exemption → $258.51 a period by the period table.
    expect(spec('NY').annualTax(base({ annualWages: 120_000, allowances: 1 })) / 24).toBeCloseTo(258.51, 1);
    // Example 1: weekly $400, single, 3 exemptions → $8.01.
    expect(spec('NY').annualTax(base({ annualWages: 20_800, allowances: 3 })) / 52).toBeCloseTo(8.01, 1);
    // Method III above $1,077,550 of net wages: a flat 10.45%.
    expect(spec('NY').annualTax(base({ annualWages: 2_007_400, allowances: 0 }))).toBeCloseTo(2_000_000 * 0.1045, 2);
  });

  it('NYC resident tax: the 2026 schedule after Table A ($5,000 single + $1,000 per exemption)', () => {
    const r = calculateInHouse({
      wages: 400, payFrequency: 'WEEKLY', residence: { state: 'NY', city: 'Brooklyn' }, work: [{ state: 'NY', city: 'Brooklyn', hours: 40 }], certificates: [],
      federalFilingStatus: 'SINGLE', federalCycleWithholding: 0,
      stateW4s: { NY: { filingStatus: 'SINGLE', allowances: 3, dependents: 0, additionalWithholding: 0, exempt: false } },
    });
    // 20,800 − 5,000 − 3,000 = 12,800 → 184 + 4,100 × 3.25% = 317.25 ÷ 52 = 6.10.
    expect(r.lines.find((l) => l.code === 'NY-NYC')!.amount).toBe(6.1);
  });

  it('OH (Optional Computer Formula, effective August 1, 2026)', () => {
    // $2,000 biweekly, 1 exemption: 52,000 − 650 = 51,350 → 416.80 + 25,300 × 2.99% = 1,173.27.
    expect(spec('OH').annualTax(base({ annualWages: 52_000, allowances: 1 }))).toBeCloseTo(1_173.27, 2);
    // Under $26,050 withholds 1.6% (the flat-rate transition withholds on every dollar).
    expect(spec('OH').annualTax(base({ annualWages: 20_800 }))).toBeCloseTo(332.8, 2);
  });

  it('MN (2026 Computer Formula)', () => {
    // 52,000 − 5,300 = 46,700 → 1,782.09 + 8,690 × 6.8% = 2,373.01.
    expect(spec('MN').annualTax(base({ annualWages: 52_000, allowances: 1 }))).toBeCloseTo(2_373.01, 2);
  });

  it('AL (2026 booklet example: weekly $850, M-2, federal $35.19 a week → $1,538.50)', () => {
    expect(spec('AL').annualTax(base({ annualWages: 44_200, filingStatus: 'MARRIED', dependents: 2, annualFederalWithholding: 35.19 * 52 }))).toBeCloseTo(1_538.5, 0);
  });

  it('IA (2026 formula example 1: biweekly $2,100, Other, $40 allowance → $59.26)', () => {
    expect(spec('IA').annualTax(base({ annualWages: 2_100 * 26, allowances: 1 })) / 26).toBeCloseTo(59.26, 2);
  });

  it('HI (Booklet A example: weekly $500, single, 3 allowances → $497.99 a year)', () => {
    expect(spec('HI').annualTax(base({ annualWages: 26_000, allowances: 3 }))).toBeCloseTo(497.99, 2);
  });

  it('MO (2026 formula example: $35,000, married, spouse works → $707.81)', () => {
    expect(spec('MO').annualTax(base({ annualWages: 35_000, filingStatus: 'MARRIED' }))).toBeCloseTo(707.81, 2);
  });

  it('OR (150-206-436 example 1: $25,000, single, 0 allowances, $1,000 federal → $1,789, plus 0.1% transit)', () => {
    expect(spec('OR').annualTax(base({ annualWages: 25_000, annualFederalWithholding: 1_000 }))).toBeCloseTo(1_788.88 + 25, 1);
  });

  it('RI (2026 booklet example: weekly $2,195, 1 exemption → $87.57)', () => {
    expect(spec('RI').annualTax(base({ annualWages: 2_195 * 52, allowances: 1 })) / 52).toBeCloseTo(87.57, 1);
  });

  it('VT (GB-1210-2026 example: weekly $1,800, married, 2 allowances → $45.77)', () => {
    expect(spec('VT').annualTax(base({ annualWages: 93_600, filingStatus: 'MARRIED', allowances: 2 })) / 52).toBeCloseTo(45.77, 1);
  });

  it('KS, NE, ND, MD and CT, worked from their 2026 tables', () => {
    // KS: 52,000 − 9,160 = 42,840 → 1,196 + 16,235 × 5.58%.
    expect(spec('KS').annualTax(base({ annualWages: 52_000, allowances: 1 }))).toBeCloseTo(1_196 + 16_235 * 0.0558, 2);
    // NE: 52,000 − 2,440 = 49,560 → 1,343.55 + 9,430 × 4.48%.
    expect(spec('NE').annualTax(base({ annualWages: 52_000, allowances: 1 }))).toBeCloseTo(1_343.55 + 9_430 * 0.0448, 2);
    // ND: 104,000 single → 46,375 × 1.95%; 52,000 → nothing.
    expect(spec('ND').annualTax(base({ annualWages: 104_000 }))).toBeCloseTo(904.31, 2);
    expect(spec('ND').annualTax(base({ annualWages: 52_000 }))).toBe(0);
    // MD Montgomery (3.20%): 52,000 − 3,400 − 3,200 = 45,400 × 7.95%.
    expect(spec('MD').annualTax(base({ annualWages: 52_000, allowances: 1, county: 'Montgomery' }))).toBeCloseTo(3_609.3, 2);
    // CT Code F, $52,000: no exemption; 2,000 + 2,000 × 5.5% = 2,110, less the 10% credit = 1,899.
    expect(spec('CT').annualTax(base({ annualWages: 52_000, rawStatus: 'F' }))).toBeCloseTo(1_899, 2);
    // No CT-W4 on file: Code D — no exemption, no credit, and Table C's $25 add-back (Code A or D, $50,250–$52,750).
    expect(spec('CT').annualTax(base({ annualWages: 52_000, hasCertificate: false }))).toBeCloseTo(2_135, 2);
  });

  it('NC (NC-30 2026: married uses the same $12,750 deduction as single) and UT (Pub 14, 1.3% phase-out)', () => {
    expect(spec('NC').annualTax(base({ annualWages: 52_000, filingStatus: 'MARRIED' }))).toBeCloseTo((52_000 - 12_750) * 0.0409, 2);
    // UT single $52,000: 52,000 × 4.45% − (485 − (52,000 − 9,348) × 1.3%, not below 0).
    expect(spec('UT').annualTax(base({ annualWages: 52_000 }))).toBeCloseTo(52_000 * 0.0445, 2);
  });

  it('the states read from 2026 guides no longer wait on a payroll-admin review; the rest still do', () => {
    for (const s of ['AL', 'CT', 'HI', 'IA', 'KS', 'MD', 'MO', 'ND', 'NE', 'OR', 'RI', 'VT', 'CA', 'NY', 'OH', 'MN']) {
      expect(VERIFIED_STATE_SPECS[s], s).toBeDefined();
      expect(STATE_SPECS[s], s).toBeUndefined();
    }
    for (const s of ['AR', 'DE', 'DC', 'LA', 'ME', 'MS', 'MT', 'NM', 'OK', 'SC', 'WV', 'WI']) expect(STATE_SPECS[s]?.verified, s).toBe(false);
  });
});
