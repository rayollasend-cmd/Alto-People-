import { beforeAll, describe, expect, it } from 'vitest';
import { __setPayrollTaxConfigForTesting } from '../../lib/payrollTax.js';
import { bonusTaxes, solveGrossUp } from '../../lib/grossUp.js';
import { applySettled, dueToRun, type DailySettledTotals } from '../../lib/dailyPay.js';
import { CHILD_CREDIT, estimateW4 } from '../../lib/w4Estimator.js';
import { manualNet } from '../../lib/manualChecks.js';
import type { ProjectedItem } from '../../lib/payrollAggregator.js';

/**
 * PAYEXP math with known answers: the bonus gross-up, the daily-pay
 * true-up arithmetic, the W-4 estimator, and a manual check's net.
 * Same 2026 tables as payrollTax.test.ts.
 */

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
    ssWageBase: 176_100,
    medicareSurchargeThreshold: 200_000,
  });
});

const base = { state: 'FL', payFrequency: 'BIWEEKLY' as const, ytdWages: 0 };

/** The solver's answer is the smallest cent that reaches the target. */
function expectMinimal(input: Parameters<typeof solveGrossUp>[0]) {
  const r = solveGrossUp(input);
  expect(r.net).toBeGreaterThanOrEqual(input.targetNet);
  expect(bonusTaxes(Math.round((r.gross - 0.01) * 100) / 100, input).net).toBeLessThan(input.targetNet);
  return r;
}

describe('bonus gross-up (net-to-gross)', () => {
  it('Florida, first dollar of the year: 22% federal + 7.65% FICA → $1,000 take-home needs $1,421.46', () => {
    const r = expectMinimal({ ...base, targetNet: 1000 });
    expect(r.gross).toBe(1421.46);
    expect(r.federal).toBe(312.72);
    expect(r.socialSecurity).toBe(88.13);
    expect(r.medicare).toBe(20.61);
    expect(r.state).toBe(0);
    expect(r.stateMethod).toBe('NONE');
    expect(r.federalMethod).toBe('SUPPLEMENTAL_22');
  });

  it('past the Social Security wage base and the Medicare surcharge line: no 6.2%, 2.35% Medicare', () => {
    const r = expectMinimal({ ...base, targetNet: 1000, ytdWages: 210_000 });
    expect(r.socialSecurity).toBe(0);
    expect(r.gross).toBeCloseTo(1000 / (1 - 0.22 - 0.0235), 1);
  });

  it('crossing the wage base mid-bonus taxes only the part under it', () => {
    const r = expectMinimal({ ...base, targetNet: 2000, ytdWages: 176_100 - 500 });
    expect(r.socialSecurity).toBe(31); // 6.2% of the last $500 of room
  });

  it('over $1M of supplemental wages: 37% federal', () => {
    const r = expectMinimal({ ...base, targetNet: 1000, ytdWages: 1_200_000, ytdSupplementalWages: 1_000_000 });
    expect(r.federalMethod).toBe('SUPPLEMENTAL_37_OVER_1M');
    expect(r.gross).toBeCloseTo(1000 / (1 - 0.37 - 0.0235), 1);
  });

  it('straddling the $1M line splits 22% / 37%', () => {
    const r = expectMinimal({ ...base, targetNet: 5000, ytdWages: 1_200_000, ytdSupplementalWages: 999_000 });
    expect(r.federalMethod).toBe('MIXED');
    expect(r.federal).toBeCloseTo(1000 * 0.22 + (r.gross - 1000) * 0.37, 1);
  });

  it('California uses its 10.23% bonus rate', () => {
    const r = expectMinimal({ ...base, state: 'CA', targetNet: 1000 });
    expect(r.stateMethod).toBe('SUPPLEMENTAL_RATE');
    expect(r.gross).toBeCloseTo(1000 / (1 - 0.22 - 0.0765 - 0.1023), 1);
  });

  it('a state without a bonus rate uses the aggregate method on top of the regular check', () => {
    const r = expectMinimal({ ...base, state: 'GA', targetNet: 1000, regularPeriodGross: 1500 });
    expect(r.stateMethod).toBe('AGGREGATE');
    expect(r.state).toBeGreaterThan(0);
  });

  it('opted-in 401(k) deferral is grossed up too and lowers income tax, not FICA', () => {
    const r = expectMinimal({ ...base, targetNet: 1000, preTaxPercent: 0.05 });
    expect(r.preTax).toBeCloseTo(r.gross * 0.05, 1);
    expect(r.federal).toBeCloseTo((r.gross - r.preTax) * 0.22, 1);
    expect(r.socialSecurity).toBeCloseTo(r.gross * 0.062, 1);
    expect(r.gross).toBeCloseTo(1000 / (1 - 0.05 - 0.95 * 0.22 - 0.0765), 0);
  });

  it('refuses a non-positive take-home', () => {
    expect(() => solveGrossUp({ ...base, targetNet: 0 })).toThrow();
  });
});

describe('daily pay true-up (one item)', () => {
  const item = (): ProjectedItem =>
    ({
      associateId: 'a',
      hoursWorked: 45,
      grossPay: 950,
      earnings: [
        { kind: 'REGULAR', hours: 40, rate: 20, amount: 800, isTaxable: true },
        { kind: 'OVERTIME', hours: 5, rate: 30, amount: 150, isTaxable: true },
      ],
      federalIncomeTax: 60,
      fica: 58.9,
      medicare: 13.78,
      stateIncomeTax: 0,
      localIncomeTax: 0,
      employerFica: 58.9,
      employerMedicare: 13.78,
      employerFuta: 5.7,
      employerSuta: 25.65,
      netPay: 817.32,
      disposableEarnings: 817.32,
      taxLines: [],
    }) as unknown as ProjectedItem;
  const settled: DailySettledTotals = {
    hours: 45, gross: 900, federal: 70, fica: 55.8, medicare: 13.05, state: 0, local: 0,
    employerFica: 55.8, employerMedicare: 13.05, employerFuta: 5.4, employerSuta: 24.3, days: 5, linkIds: [],
  };

  it('pays what is left: the overtime premium, less the taxes not yet withheld', () => {
    const p = item();
    const short = new Map<string, number>();
    applySettled(p, settled, short);
    expect(p.grossPay).toBe(50);
    expect(p.earnings.at(-1)).toMatchObject({ kind: 'DAILY_SETTLED', amount: -900 });
    expect(p.earnings.reduce((s, e) => s + e.amount, 0)).toBe(50);
    // Daily checks withheld a little more federal than the week's truth: never below $0.
    expect(p.federalIncomeTax).toBe(0);
    expect(p.fica).toBe(3.1);
    expect(p.medicare).toBe(0.73);
    expect(p.netPay).toBe(Math.round((50 - 3.1 - 0.73) * 100) / 100);
    expect(short.size).toBe(0);
  });

  it('carries deductions the true-up cannot cover to the next check', () => {
    const p = item();
    p.netPay = 700; // $117.32 of deductions on the week
    const short = new Map<string, number>();
    applySettled(p, settled, short);
    expect(p.netPay).toBe(0);
    expect(short.get('a')).toBeGreaterThan(0);
  });

  it('the nightly timer runs once a day after the hour for its timing', () => {
    const at = (iso: string) => new Date(iso);
    expect(dueToRun({ status: 'ACTIVE', timing: 'NEXT_DAY', lastRunAt: null }, at('2026-10-18T05:00:00Z'))).toBe(false);
    expect(dueToRun({ status: 'ACTIVE', timing: 'NEXT_DAY', lastRunAt: null }, at('2026-10-18T06:15:00Z'))).toBe(true);
    expect(dueToRun({ status: 'ACTIVE', timing: 'NEXT_DAY', lastRunAt: at('2026-10-18T06:15:00Z') }, at('2026-10-18T09:00:00Z'))).toBe(false);
    expect(dueToRun({ status: 'ACTIVE', timing: 'SAME_DAY', lastRunAt: at('2026-10-18T06:15:00Z') }, at('2026-10-18T22:05:00Z'))).toBe(true);
    expect(dueToRun({ status: 'OFF', timing: 'NEXT_DAY', lastRunAt: null }, at('2026-10-18T12:00:00Z'))).toBe(false);
  });
});

describe('W-4 estimator', () => {
  const single = { filingStatus: 'SINGLE' as const, payFrequency: 'BIWEEKLY' as const, payPerPeriod: 2000, ytdWages: 0, ytdFederalWithheld: 0 };

  it('one job, whole year ahead: the tables withhold the year’s tax (~$5,092 on $52,000)', () => {
    const r = estimateW4({ ...single, periodsRemaining: 26 });
    expect(r.yearWages).toBe(52_000);
    expect(r.estimatedTax).toBeCloseTo(5092, 0);
    expect(r.withSuggested.perCheck).toBe(195.85);
    expect(Math.abs(r.withSuggested.refund)).toBeLessThan(1);
    expect(r.suggested.extraWithholding).toBe(0);
  });

  it('a second job goes in Step 4(a) so this job withholds for both', () => {
    const r = estimateW4({ ...single, periodsRemaining: 26, otherJobsAnnual: 30_000, current: { filingStatus: 'SINGLE', dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 } });
    expect(r.estimatedTax).toBeCloseTo(11_102, 0);
    expect(r.suggested.otherIncome).toBe(30_000);
    expect(Math.abs(r.withSuggested.refund)).toBeLessThan(1);
    // As things stand (W-4 without the other job): about $6,010 owed.
    expect(r.asIs!.refund).toBeLessThan(-6000);
  });

  it('behind on withholding mid-year: an extra per check catches up, rounded up to the dollar', () => {
    const r = estimateW4({ ...single, ytdWages: 26_000, ytdFederalWithheld: 0, periodsRemaining: 13 });
    expect(r.suggested.extraWithholding).toBe(196);
    expect(r.withSuggested.refund).toBeGreaterThanOrEqual(0);
    expect(r.withSuggested.refund).toBeLessThan(13);
  });

  it('children under 17 are $2,200 each in Step 3', () => {
    const r = estimateW4({ ...single, periodsRemaining: 26, childrenUnder17: 2 });
    expect(r.credits).toBe(2 * CHILD_CREDIT);
    expect(r.suggested.dependentsAmount).toBe(4400);
    expect(r.estimatedTax).toBeCloseTo(5092 - 4400, 0);
  });
});

describe('manual check', () => {
  it('nets gross less pre-tax, taxes and after-tax deductions', () => {
    expect(manualNet({ gross: 1000, preTaxDeductions: 50, federal: 80, socialSecurity: 62, medicare: 14.5, state: 0, local: 0, postTaxDeductions: 25 })).toBe(768.5);
  });
});
