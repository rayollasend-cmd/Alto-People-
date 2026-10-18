import type { W4FilingStatus } from '@prisma/client';
import {
  MEDICARE_RATE,
  MEDICARE_SURCHARGE_RATE,
  MEDICARE_SURCHARGE_THRESHOLD,
  NO_SIT_STATES,
  SS_RATE,
  SS_WAGE_BASE,
  computeStateIncomeTax,
  type PayFrequency,
} from './payrollTax.js';

/**
 * Bonus gross-up (net-to-gross): the gross a bonus must be for the person
 * to take home exactly `targetNet`.
 *
 *   Federal   supplemental wages are withheld at a flat 22%, and 37% on the
 *             part of the year's supplemental wages over $1,000,000
 *             (Pub 15 §7 — the mandatory flat rate above $1M).
 *   FICA      6.2% Social Security until the year's wage base, 1.45%
 *             Medicare plus 0.9% on wages over the surcharge threshold.
 *   State     a published supplemental rate where the state sets one for
 *             bonuses (CA, NY); a flat-tax state's own rate; otherwise the
 *             aggregate method — the tax on (regular period + bonus) minus
 *             the tax on the regular period alone.
 *   Pre-tax   an opted-in 401(k)-style deferral reduces the income-tax
 *             base, not FICA — and is part of the gross, not the take-home.
 *
 * The take-home rises with the gross at every point (no marginal rate
 * reaches 100%), so a bisection finds the cent; a final pass steps up a
 * cent at a time until rounding can't leave the person short.
 */

/** Supplemental (bonus) withholding rates states publish, used instead of the regular tables. */
export const STATE_SUPPLEMENTAL_BONUS_RATES: Record<string, { rate: number; source: string }> = {
  // California EDD: bonuses and stock options 10.23%; other supplemental wages 6.6%.
  CA: { rate: 0.1023, source: 'California EDD, supplemental wages — bonuses and stock options' },
  // New York: supplemental withholding rate for New York State.
  NY: { rate: 0.117, source: 'New York State supplemental withholding rate' },
};

export const FEDERAL_SUPPLEMENTAL_RATE = 0.22;
export const FEDERAL_SUPPLEMENTAL_MAX_RATE = 0.37;
export const FEDERAL_SUPPLEMENTAL_MAX_THRESHOLD = 1_000_000;

export interface GrossUpInput {
  targetNet: number;
  state: string | null;
  /** The worker's regular pay frequency — the aggregate method's period. */
  payFrequency: PayFrequency;
  filingStatus?: W4FilingStatus | null;
  /** Wages already paid this year (Social Security base, Medicare surcharge). */
  ytdWages: number;
  /** Supplemental wages already paid this year (the $1M federal line). */
  ytdSupplementalWages?: number;
  /** A typical regular paycheck's gross, for the state aggregate method. */
  regularPeriodGross?: number;
  /** Opted-in pre-tax deferral on the bonus, as a fraction (0.05 = 5%). */
  preTaxPercent?: number;
  /** A flat local wage tax rate on the gross, if one applies. */
  localRate?: number;
}

export interface GrossUpBreakdown {
  targetNet: number;
  gross: number;
  preTax: number;
  federal: number;
  socialSecurity: number;
  medicare: number;
  state: number;
  local: number;
  net: number;
  /** How the state share was worked out, for the line the person sees. */
  stateMethod: 'NONE' | 'SUPPLEMENTAL_RATE' | 'FLAT_STATE' | 'AGGREGATE';
  federalMethod: 'SUPPLEMENTAL_22' | 'SUPPLEMENTAL_37_OVER_1M' | 'MIXED';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The taxes and take-home on a bonus of `gross` (no solving). */
export function bonusTaxes(gross: number, input: Omit<GrossUpInput, 'targetNet'>): Omit<GrossUpBreakdown, 'targetNet'> {
  const g = round2(Math.max(0, gross));
  const preTax = round2(g * Math.max(0, Math.min(1, input.preTaxPercent ?? 0)));
  const incomeBase = round2(g - preTax);

  // Federal: 22% up to the $1M line of the year's supplemental wages, 37% beyond it.
  const ytdSupp = Math.max(0, input.ytdSupplementalWages ?? 0);
  const roomAt22 = Math.max(0, FEDERAL_SUPPLEMENTAL_MAX_THRESHOLD - ytdSupp);
  const at22 = Math.min(incomeBase, roomAt22);
  const at37 = Math.max(0, incomeBase - at22);
  const federal = round2(at22 * FEDERAL_SUPPLEMENTAL_RATE + at37 * FEDERAL_SUPPLEMENTAL_MAX_RATE);
  const federalMethod: GrossUpBreakdown['federalMethod'] = at37 === 0 ? 'SUPPLEMENTAL_22' : at22 === 0 ? 'SUPPLEMENTAL_37_OVER_1M' : 'MIXED';

  // FICA on the full gross (a 401(k) deferral is FICA wages).
  const ssRoom = Math.max(0, SS_WAGE_BASE() - Math.max(0, input.ytdWages));
  const socialSecurity = round2(Math.min(g, ssRoom) * SS_RATE);
  const threshold = MEDICARE_SURCHARGE_THRESHOLD();
  const over = Math.max(0, Math.min(g, input.ytdWages + g - threshold));
  const medicare = round2(g * MEDICARE_RATE + over * MEDICARE_SURCHARGE_RATE);

  // State.
  const st = input.state?.toUpperCase().trim() ?? null;
  let state = 0;
  let stateMethod: GrossUpBreakdown['stateMethod'] = 'NONE';
  if (st && !NO_SIT_STATES.has(st)) {
    const published = STATE_SUPPLEMENTAL_BONUS_RATES[st];
    if (published) {
      state = round2(incomeBase * published.rate);
      stateMethod = 'SUPPLEMENTAL_RATE';
    } else {
      const regular = Math.max(0, input.regularPeriodGross ?? 0);
      const common = { state: st, payFrequency: input.payFrequency, federalFilingStatus: input.filingStatus ?? null };
      const onBoth = computeStateIncomeTax({ ...common, grossPay: regular + incomeBase });
      const onRegular = computeStateIncomeTax({ ...common, grossPay: regular });
      state = round2(Math.max(0, onBoth - onRegular));
      // A flat-tax state charges the same rate either way; name it plainly.
      const flatProbe = computeStateIncomeTax({ ...common, grossPay: 1000 });
      const flatProbe2 = computeStateIncomeTax({ ...common, grossPay: 2000 });
      stateMethod = Math.abs(flatProbe2 - 2 * flatProbe) < 0.02 && regular === 0 ? 'FLAT_STATE' : 'AGGREGATE';
    }
  }

  const local = round2(g * Math.max(0, input.localRate ?? 0));
  const net = round2(g - preTax - federal - socialSecurity - medicare - state - local);
  return { gross: g, preTax, federal, socialSecurity, medicare, state, local, net, stateMethod, federalMethod };
}

/** The gross whose take-home is `targetNet` (to the cent, never short). */
export function solveGrossUp(input: GrossUpInput): GrossUpBreakdown {
  const target = round2(input.targetNet);
  if (!(target > 0)) throw new Error('targetNet must be positive');
  const netOf = (g: number) => bonusTaxes(g, input).net;

  let lo = target;
  let hi = target * 2;
  // Widen until the take-home clears the target (high-tax combinations).
  for (let i = 0; i < 20 && netOf(hi) < target; i++) hi *= 1.5;
  for (let i = 0; i < 80 && hi - lo > 0.001; i++) {
    const mid = (lo + hi) / 2;
    if (netOf(mid) < target) lo = mid;
    else hi = mid;
  }
  let gross = round2(hi);
  // Rounding can leave a cent short; step up until it can't.
  for (let i = 0; i < 100 && netOf(gross) < target; i++) gross = round2(gross + 0.01);
  // And never a cent more than needed.
  while (gross > target && netOf(round2(gross - 0.01)) >= target) gross = round2(gross - 0.01);
  return { targetNet: target, ...bonusTaxes(gross, input) };
}
