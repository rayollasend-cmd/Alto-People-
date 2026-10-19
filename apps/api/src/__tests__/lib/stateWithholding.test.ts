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
  AR: { expected: 1_001.15, why: '2026: 40,000 − 2,470 = 37,530 → 108 + 141 + 343.40 + 11,831 × 3.7% (437.75), − 29 credit' },
  DE: { expected: 1_543.13, why: '36,750 after std → 66 + 195 + 480 + 260 + 652.13, − 110' },
  DC: { expected: 1_300, why: '25,000 after std → 400 + 900' },
  LA: { expected: 838.16, why: '2026: (40,000 − 12,875) × 3.09%' },
  ME: { expected: 1_125.2, why: '2026: 40,000 − 15,300 − 5,300 = 19,400 × 5.8%' },
  MS: { expected: 868, why: '40,000 − 2,300 − 6,000 = 31,700; 21,700 over 10,000 × 4%' },
  MT: { expected: 1_175, why: '25,000 after std × 4.7%' },
  NM: { expected: 800, why: '25,000 → 82.5 + 352 + 365.5' },
  OK: { expected: 1_254.5, why: '2026 OW-2: 40,000 − 1,000 = 39,000 → 0 to 10,100; 28.75 + 80.50 + 25,450 × 4.5%' },
  SC: { expected: 1_218.3, why: '2026 WH-1603: 40,000 − 4,000 std − 5,000 = 31,000 → 428.10 + 13,170 × 6%' },
  WV: { expected: 1_043.3, why: '2026 (SB 392): 38,000 after 1 exemption → 211 + 421.50 + 410.80' },
  WI: { expected: 1_577.4, why: '2026: std 6,702 − 12% × 22,220 = 4,035.60; 35,564.40 after $400 → 451.70 + 593.34 + 532.35' },
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
    expect(STATE_SPECS.LA!.annualTax({ ...BASE, filingStatus: 'MARRIED' })).toBeCloseTo(440.33, 2); // (40,000 − 25,750) × 3.09%
  });
  it('a Maryland certificate without a known county uses the 2026 “Unknown Maryland” rate, 3.30%', () => {
    expect(mdCountyRate('Worcester')).toEqual({ rate: 0.0225, known: true });
    expect(mdCountyRate('Kent')).toEqual({ rate: 0.033, known: true });
    expect(mdCountyRate(null)).toEqual({ rate: 0.033, known: false });
  });
  it('per period: annual over periods, plus the extra; exempt withholds nothing', () => {
    const de = STATE_SPECS.DE!;
    const cycle = stateCycleWithholding(de, { cycleWages: 40_000 / 26, periods: 26, federalFilingStatus: 'SINGLE', federalCycleWithholding: 2_500 / 26, stateW4: { filingStatus: 'SINGLE', allowances: 1, dependents: 0, additionalWithholding: 5, exempt: false } });
    expect(cycle).toBeCloseTo(1_543.13 / 26 + 5, 2);
    expect(stateCycleWithholding(de, { cycleWages: 2_000, periods: 26, federalFilingStatus: null, federalCycleWithholding: 0, stateW4: { filingStatus: 'SINGLE', allowances: 0, dependents: 0, additionalWithholding: 0, exempt: true } })).toBe(0);
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
