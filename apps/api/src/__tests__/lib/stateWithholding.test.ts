import { describe, expect, it, beforeEach } from 'vitest';
import { STATE_SPECS, NEW_STATES, mdCountyRate, progressive, stateCycleWithholding, type StateCalcInput } from '../../lib/stateWithholding.js';
import {
  __resetStateAcknowledgmentsForTesting,
  computeStateIncomeTax,
  isStateTaxSupported,
  primeStateAcknowledgments,
  stateAwaitingReview,
  stateCoverageOf,
  supportedStates,
} from '../../lib/payrollTax.js';

/**
 * Each added state's method, worked by hand for one single filer earning
 * $40,000 a year with one allowance and $2,500 of federal withholding
 * (Montgomery County for Maryland). A transcription slip in a table shows
 * up here as a mismatch against the arithmetic written beside it.
 */

const BASE: StateCalcInput = { annualWages: 40_000, filingStatus: 'SINGLE', allowances: 1, dependents: 0, annualFederalWithholding: 2_500, county: 'MONTGOMERY' };

const WORKED: Record<string, { expected: number; why: string }> = {
  AL: { expected: 1_635, why: '40,000 − 2,500 fed − 2,500 std (floor) − 1,500 personal = 33,500 → 10 + 100 + 30,500 × 5%' },
  AR: { expected: 1_027.15, why: '40,000 − 2,410 = 37,590 → 108 + 140.97 + 343.4 + 464.81 tiers, − 29 credit' },
  CT: { expected: 1_325, why: 'exemption 15,000 − 10,000 phase-out = 5,000 → 35,000: 200 + 1,125' },
  DE: { expected: 1_543.13, why: '36,750 after std → 66 + 195 + 480 + 260 + 652.13, − 110' },
  DC: { expected: 1_300, why: '25,000 after std → 400 + 900' },
  HI: { expected: 1_880.83, why: '38,856 after 1 allowance → bracket walk to 7.2%' },
  IA: { expected: 1_480, why: '40,000 × 3.8% − 40' },
  KS: { expected: 1_813.99, why: '40,000 − 3,605 − 2,320 = 34,075 → 1,196 + 617.99' },
  LA: { expected: 825, why: '(40,000 − 12,500) × 3%' },
  ME: { expected: 1_151.3, why: '40,000 − 15,000 − 5,150 = 19,850 × 5.8%' },
  MD: { expected: 2_606.78, why: '33,450 taxable → 1,536.38 state + 1,070.40 Montgomery 3.2%' },
  MO: { expected: 999.06, why: '25,000 after std → tiers to 4.7%' },
  MS: { expected: 868, why: '40,000 − 2,300 − 6,000 = 31,700; 21,700 over 10,000 × 4%' },
  MT: { expected: 1_175, why: '25,000 after std × 4.7%' },
  NE: { expected: 1_419.49, why: '37,810 after 1 allowance → 2.46 / 3.51 / 4.55%' },
  NM: { expected: 800, why: '25,000 → 82.5 + 352 + 365.5' },
  ND: { expected: 0, why: '25,000 after std is under the 48,475 zero bracket' },
  OK: { expected: 1_362.38, why: '40,000 − 6,350 − 1,000 = 32,650 → tiers to 4.75%' },
  OR: { expected: 2_508.19, why: '34,665 after fed + std → 2,724.19 − 256 credit + 40 transit' },
  RI: { expected: 1_308.75, why: '34,900 after 1 exemption × 3.75%' },
  SC: { expected: 1_255.18, why: '40,000 − 4,000 std − 4,830 = 31,170 → 428.1 + 827.08' },
  VT: { expected: 1_162.45, why: '34,700 after 1 allowance × 3.35%' },
  WV: { expected: 1_098.9, why: '38,000 after 1 exemption → tiers to 4.44%' },
  WI: { expected: 1_152.96, why: 'std 12,760 − 12% × 22,220 = 10,093.6; 29,206.4 → 513.8 + 639.16' },
};

describe('the added states, worked', () => {
  it('covers every added state and DC exactly once', () => {
    expect(NEW_STATES).toEqual(Object.keys(WORKED).sort());
    for (const s of NEW_STATES) {
      expect(STATE_SPECS[s]!.verified).toBe(false);
      expect(STATE_SPECS[s]!.source.length).toBeGreaterThan(20);
      expect([2025, 2026]).toContain(STATE_SPECS[s]!.taxYear);
    }
  });
  for (const [state, { expected, why }] of Object.entries(WORKED)) {
    it(`${state}: ${why}`, () => {
      expect(Math.round(STATE_SPECS[state]!.annualTax(BASE) * 100) / 100).toBeCloseTo(expected, 2);
    });
  }
});

describe('the pieces', () => {
  it('a progressive walk stops at the wages', () => {
    expect(progressive(15_000, [[10_000, 0.1], [Infinity, 0.2]])).toBe(2_000);
    expect(progressive(-5, [[10_000, 0.1]])).toBe(0);
  });
  it('married filers get the married table', () => {
    expect(STATE_SPECS.NM!.annualTax({ ...BASE, filingStatus: 'MARRIED' })).toBeCloseTo(184, 2); // 10,000 after 30,000 std: 8,000 × 1.5% + 2,000 × 3.2%
    expect(STATE_SPECS.LA!.annualTax({ ...BASE, filingStatus: 'MARRIED' })).toBe(450);
  });
  it('a Maryland certificate without a known county uses 3.20%', () => {
    expect(mdCountyRate('Worcester')).toEqual({ rate: 0.0225, known: true });
    expect(mdCountyRate(null)).toEqual({ rate: 0.032, known: false });
  });
  it('per period: annual over periods, plus the extra; exempt withholds nothing', () => {
    const al = STATE_SPECS.AL!;
    const cycle = stateCycleWithholding(al, { cycleWages: 40_000 / 26, periods: 26, federalFilingStatus: 'SINGLE', federalCycleWithholding: 2_500 / 26, stateW4: { filingStatus: 'SINGLE', allowances: 1, dependents: 0, additionalWithholding: 5, exempt: false } });
    expect(cycle).toBeCloseTo(1_635 / 26 + 5, 2);
    expect(stateCycleWithholding(al, { cycleWages: 2_000, periods: 26, federalFilingStatus: null, federalCycleWithholding: 0, stateW4: { filingStatus: 'SINGLE', allowances: 0, dependents: 0, additionalWithholding: 0, exempt: true } })).toBe(0);
  });
});

describe('the review gate', () => {
  beforeEach(() => __resetStateAcknowledgmentsForTesting());
  it('an added state computes, but is not covered until reviewed for its tax year', async () => {
    expect(computeStateIncomeTax({ grossPay: 2_000, state: 'DE', payFrequency: 'BIWEEKLY' })).toBeGreaterThan(0);
    expect(isStateTaxSupported('DE')).toBe(false);
    expect(stateAwaitingReview('DE')).toMatchObject({ state: 'DE', taxYear: 2025 });
    expect(stateCoverageOf('DE')).toBe('awaiting_review');
    expect(supportedStates()).not.toContain('DE');

    // A review of an older tax year doesn't count.
    await primeStateAcknowledgments({ stateTaxAcknowledgment: { findMany: async () => [{ state: 'DE', taxYear: 2024 }] } });
    expect(isStateTaxSupported('DE')).toBe(false);

    await primeStateAcknowledgments({ stateTaxAcknowledgment: { findMany: async () => [{ state: 'DE', taxYear: 2025 }] } });
    expect(isStateTaxSupported('DE')).toBe(true);
    expect(stateCoverageOf('DE')).toBe('acknowledged');
    expect(supportedStates()).toContain('DE');
  });
  it('the verified states stay covered without any review', () => {
    expect(isStateTaxSupported('FL')).toBe(true);
    expect(stateCoverageOf('CA')).toBe('verified');
    expect(stateCoverageOf('XX')).toBe('none');
  });
});
