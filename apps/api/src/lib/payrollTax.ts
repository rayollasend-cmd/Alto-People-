import type { W4FilingStatus } from '@prisma/client';
import { round2 } from './payroll.js';

/**
 * Multi-jurisdiction payroll tax engine (Phase 18).
 *
 * Computes the per-paycheck tax breakdown for one associate at one pay
 * cycle: federal income tax, FICA (Social Security + Medicare with the
 * additional Medicare surcharge), state income tax, and the employer-side
 * matches that the company itself owes.
 *
 * Numbers anchored to **calendar year 2024** IRS Pub 15-T + SSA wage base.
 * Bumping years means editing the constants in this file — no callers
 * change. NOT a drop-in replacement for a payroll-tax SaaS like Symmetry,
 * Avalara, or Gusto Embedded; this is good enough for an internal HR
 * platform processing W-2 wages where the business has accepted the
 * compliance responsibility for keeping these tables current.
 *
 * Design choices:
 *  - Pure functions, no IO. Caller passes in YTD snapshots and we return
 *    the breakdown — keeps the engine trivially testable.
 *  - Bi-weekly is the default pay frequency. Other frequencies need their
 *    own bracket tables; we expose `payFrequency` so future work plugs in.
 *  - State income tax uses a real progressive table for CA + NY (the two
 *    largest non-zero-tax states by associate count for hospitality/J-1),
 *    explicit zero for the nine no-SIT states, and a flat 4% fallback for
 *    everywhere else with a TODO for proper per-state tables. The fallback
 *    is intentionally on the high side so we never under-withhold.
 */

export type PayFrequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';

// ---------- Federal income tax (IRS Pub 15-T 2024, percentage method) ------

interface Bracket {
  /** Lower bound of this bracket (inclusive). */
  over: number;
  /** Flat tax owed when entering this bracket. */
  flat: number;
  /** Marginal rate above `over`. */
  rate: number;
}

// Annualized brackets for the percentage method, "Standard withholding"
// (W-4 step 2 box NOT checked). Source: IRS Pub 15-T 2024, Worksheet 1A.
// We annualize the per-cycle gross before lookup, then divide back.
const FED_BRACKETS_2024: Record<W4FilingStatus, Bracket[]> = {
  SINGLE: [
    { over: 0, flat: 0, rate: 0 },
    { over: 6_000, flat: 0, rate: 0.1 }, // first 6000 of taxable wages exempt via standard deduction adjustment
    { over: 17_600, flat: 1_160, rate: 0.12 },
    { over: 53_150, flat: 5_426, rate: 0.22 },
    { over: 100_525, flat: 15_840.5, rate: 0.24 },
    { over: 187_025, flat: 36_600.5, rate: 0.32 },
    { over: 233_750, flat: 51_552.5, rate: 0.35 },
    { over: 578_125, flat: 172_623.75, rate: 0.37 },
  ],
  MARRIED_FILING_JOINTLY: [
    { over: 0, flat: 0, rate: 0 },
    { over: 16_300, flat: 0, rate: 0.1 },
    { over: 39_500, flat: 2_320, rate: 0.12 },
    { over: 110_600, flat: 10_852, rate: 0.22 },
    { over: 205_350, flat: 31_697, rate: 0.24 },
    { over: 378_350, flat: 73_217, rate: 0.32 },
    { over: 471_800, flat: 103_121, rate: 0.35 },
    { over: 691_750, flat: 180_104, rate: 0.37 },
  ],
  HEAD_OF_HOUSEHOLD: [
    { over: 0, flat: 0, rate: 0 },
    { over: 13_300, flat: 0, rate: 0.1 },
    { over: 29_850, flat: 1_655, rate: 0.12 },
    { over: 76_400, flat: 7_241, rate: 0.22 },
    { over: 113_800, flat: 15_469, rate: 0.24 },
    { over: 200_300, flat: 36_229, rate: 0.32 },
    { over: 247_025, flat: 51_181, rate: 0.35 },
    { over: 591_400, flat: 171_712.25, rate: 0.37 },
  ],
};

const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  SEMIMONTHLY: 24,
  MONTHLY: 12,
};

function pickBracket(table: Bracket[], annualGross: number): Bracket {
  let chosen = table[0];
  for (const b of table) {
    if (annualGross >= b.over) chosen = b;
    else break;
  }
  return chosen;
}

export interface FederalInput {
  grossPay: number;
  filingStatus: W4FilingStatus | null;
  payFrequency: PayFrequency;
  /** W-4 step 4(c) — flat per-cycle add-on. Already at the cycle scale. */
  extraWithholding?: number;
  /** W-4 step 4(b) — annual deductions claimed. Reduces taxable wages. */
  deductions?: number;
  /** W-4 step 4(a) — annual other income. Increases taxable wages. */
  otherIncome?: number;
  /** W-4 step 3 — annual dependents tax credit. Reduces final withholding. */
  dependentsAmount?: number;
}

export function computeFederalIncomeTax(input: FederalInput): number {
  const status = input.filingStatus ?? 'SINGLE';
  const periods = PERIODS_PER_YEAR[input.payFrequency];

  // Annualize this cycle's gross, layer the W-4 modifiers.
  const annualGross =
    input.grossPay * periods + Math.max(0, input.otherIncome ?? 0);
  const annualTaxable = Math.max(0, annualGross - Math.max(0, input.deductions ?? 0));

  const bracket = pickBracket(FED_BRACKETS_2024[status], annualTaxable);
  const annualTax = bracket.flat + (annualTaxable - bracket.over) * bracket.rate;
  const annualCredits = Math.max(0, input.dependentsAmount ?? 0);
  const annualWithholding = Math.max(0, annualTax - annualCredits);

  const cycleWithholding = annualWithholding / periods;
  const extra = Math.max(0, input.extraWithholding ?? 0);
  return round2(cycleWithholding + extra);
}

// ---------- FICA: Social Security ------------------------------------------

/** 2024 Social Security wage base. Wages above this are not subject to FICA. */
export const SS_WAGE_BASE_2024 = 168_600;
export const SS_RATE = 0.062;

export interface FicaInput {
  grossPay: number;
  /** YTD wages BEFORE this paycheck. */
  ytdWages: number;
}

export function computeSocialSecurity(input: FicaInput): number {
  const remaining = Math.max(0, SS_WAGE_BASE_2024 - input.ytdWages);
  const taxable = Math.min(input.grossPay, remaining);
  return round2(Math.max(0, taxable) * SS_RATE);
}

// ---------- Medicare ------------------------------------------------------

export const MEDICARE_RATE = 0.0145;
export const MEDICARE_SURCHARGE_RATE = 0.009;
export const MEDICARE_SURCHARGE_THRESHOLD = 200_000;

export interface MedicareInput {
  grossPay: number;
  /** YTD Medicare wages BEFORE this paycheck (no cap, unlike SS). */
  ytdMedicareWages: number;
}

export function computeMedicare(input: MedicareInput): number {
  const base = input.grossPay * MEDICARE_RATE;
  // Additional 0.9% on the portion of YTD+current that exceeds $200k.
  const after = input.ytdMedicareWages + input.grossPay;
  let surcharge = 0;
  if (after > MEDICARE_SURCHARGE_THRESHOLD) {
    const overflow = Math.min(input.grossPay, after - MEDICARE_SURCHARGE_THRESHOLD);
    surcharge = overflow * MEDICARE_SURCHARGE_RATE;
  }
  return round2(base + surcharge);
}

// ---------- State income tax ----------------------------------------------

/** States that levy no income tax (TN/NH dropped their interest+dividend tax in 2021/2025). */
export const NO_SIT_STATES = new Set([
  'FL', 'TX', 'NV', 'WA', 'AK', 'SD', 'WY', 'TN', 'NH',
]);

const CA_BRACKETS_SINGLE_2024: Bracket[] = [
  { over: 0, flat: 0, rate: 0.011 },
  { over: 10_756, flat: 118.32, rate: 0.022 },
  { over: 25_499, flat: 442.65, rate: 0.044 },
  { over: 40_245, flat: 1_091.47, rate: 0.066 },
  { over: 55_866, flat: 2_122.45, rate: 0.088 },
  { over: 70_606, flat: 3_419.57, rate: 0.1023 },
  { over: 360_659, flat: 33_077.18, rate: 0.1133 },
  { over: 432_787, flat: 41_252.74, rate: 0.1243 },
  { over: 721_314, flat: 77_117.32, rate: 0.1353 },
  { over: 1_000_000, flat: 114_811.85, rate: 0.1453 }, // 1% mental-health surtax kicks in
];

const NY_BRACKETS_SINGLE_2024: Bracket[] = [
  { over: 0, flat: 0, rate: 0.04 },
  { over: 8_500, flat: 340, rate: 0.045 },
  { over: 11_700, flat: 484, rate: 0.0525 },
  { over: 13_900, flat: 599.5, rate: 0.055 },
  { over: 80_650, flat: 4_270.6, rate: 0.06 },
  { over: 215_400, flat: 12_355.6, rate: 0.0685 },
  { over: 1_077_550, flat: 71_413.88, rate: 0.0965 },
  { over: 5_000_000, flat: 449_799, rate: 0.103 },
  { over: 25_000_000, flat: 2_509_799, rate: 0.109 },
];

/** Flat-rate fallback for states we don't have a real table for yet. */
const FALLBACK_FLAT_RATE = 0.04;

export interface StateInput {
  grossPay: number;
  /** Two-letter state code, uppercased. null → use fallback. */
  state: string | null;
  payFrequency: PayFrequency;
}

export function computeStateIncomeTax(input: StateInput): number {
  const state = input.state?.toUpperCase().trim() ?? null;
  if (state && NO_SIT_STATES.has(state)) return 0;

  const periods = PERIODS_PER_YEAR[input.payFrequency];
  const annualGross = input.grossPay * periods;

  if (state === 'CA') return annualToCycle(CA_BRACKETS_SINGLE_2024, annualGross, periods);
  if (state === 'NY') return annualToCycle(NY_BRACKETS_SINGLE_2024, annualGross, periods);

  // Generic flat fallback. TODO: add real tables for at least IL/PA/MI/AZ/CO/GA/NC/VA/NJ/MA.
  return round2(input.grossPay * FALLBACK_FLAT_RATE);
}

function annualToCycle(table: Bracket[], annualGross: number, periods: number): number {
  const b = pickBracket(table, annualGross);
  const annual = b.flat + (annualGross - b.over) * b.rate;
  return round2(Math.max(0, annual) / periods);
}

// ---------- Employer-side taxes -------------------------------------------

/** FUTA: 6.0% on first $7000/yr, with a 5.4% credit if state UI is current → effective 0.6%. */
export const FUTA_RATE_NET = 0.006;
export const FUTA_WAGE_BASE = 7_000;

export interface EmployerInput {
  grossPay: number;
  ytdWages: number;
  ytdMedicareWages: number;
}

export interface EmployerBreakdown {
  fica: number; // 6.2% match, capped at SS wage base
  medicare: number; // 1.45% match, no surcharge match (employer doesn't owe additional)
  futa: number;
  /** SUTA varies wildly per-state and per-employer. We stub at 2.7% on first $7000 — a defensible national-average new-employer rate. Override per state in a future patch. */
  suta: number;
}

export function computeEmployerTaxes(input: EmployerInput): EmployerBreakdown {
  const ssRemaining = Math.max(0, SS_WAGE_BASE_2024 - input.ytdWages);
  const ssTaxable = Math.min(input.grossPay, ssRemaining);
  const fica = round2(ssTaxable * SS_RATE);

  const medicare = round2(input.grossPay * MEDICARE_RATE);

  const futaRemaining = Math.max(0, FUTA_WAGE_BASE - input.ytdWages);
  const futaTaxable = Math.min(input.grossPay, futaRemaining);
  const futa = round2(futaTaxable * FUTA_RATE_NET);

  const sutaRemaining = Math.max(0, FUTA_WAGE_BASE - input.ytdWages);
  const sutaTaxable = Math.min(input.grossPay, sutaRemaining);
  const suta = round2(sutaTaxable * 0.027);

  return { fica, medicare, futa, suta };
}

// ---------- Aggregate ------------------------------------------------------

export interface PaycheckTaxInput {
  grossPay: number;
  filingStatus: W4FilingStatus | null;
  payFrequency: PayFrequency;
  state: string | null;
  ytdWages: number;
  ytdMedicareWages: number;
  extraWithholding?: number;
  deductions?: number;
  otherIncome?: number;
  dependentsAmount?: number;
}

export interface PaycheckTaxBreakdown {
  federalIncomeTax: number;
  socialSecurity: number;
  medicare: number;
  stateIncomeTax: number;
  totalEmployeeTax: number;
  netPay: number;
  employer: EmployerBreakdown;
}

/**
 * Phase 41 — 1099 contractors are paid gross with no withholding and
 * no employer-side payroll tax (Form 1099-NEC, Box 1 = grossPay totals).
 * Returns a breakdown shape compatible with computePaycheckTaxes so
 * downstream PayrollItem persistence stays uniform.
 */
export function zeroTaxBreakdown(grossPay: number): PaycheckTaxBreakdown {
  return {
    federalIncomeTax: 0,
    socialSecurity: 0,
    medicare: 0,
    stateIncomeTax: 0,
    totalEmployeeTax: 0,
    netPay: grossPay,
    employer: { fica: 0, medicare: 0, futa: 0, suta: 0 },
  };
}

export function computePaycheckTaxes(input: PaycheckTaxInput): PaycheckTaxBreakdown {
  const fit = computeFederalIncomeTax(input);
  const ss = computeSocialSecurity({ grossPay: input.grossPay, ytdWages: input.ytdWages });
  const med = computeMedicare({
    grossPay: input.grossPay,
    ytdMedicareWages: input.ytdMedicareWages,
  });
  const sit = computeStateIncomeTax({
    grossPay: input.grossPay,
    state: input.state,
    payFrequency: input.payFrequency,
  });
  const totalEmployeeTax = round2(fit + ss + med + sit);
  const netPay = round2(input.grossPay - totalEmployeeTax);
  const employer = computeEmployerTaxes({
    grossPay: input.grossPay,
    ytdWages: input.ytdWages,
    ytdMedicareWages: input.ytdMedicareWages,
  });
  return {
    federalIncomeTax: fit,
    socialSecurity: ss,
    medicare: med,
    stateIncomeTax: sit,
    totalEmployeeTax,
    netPay,
    employer,
  };
}
