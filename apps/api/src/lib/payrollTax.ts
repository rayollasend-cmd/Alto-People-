import type { Prisma, PrismaClient, W4FilingStatus } from '@prisma/client';
import { round2 } from './payroll.js';
import { STATE_SPECS, stateCycleWithholding, type StateW4Input } from './stateWithholding.js';
import { VERIFIED_STATE_SPECS } from './stateWithholding2026.js';
import { currentTenantId } from './tenant.js';

/**
 * Multi-jurisdiction payroll tax engine (Phase 18).
 *
 * Computes the per-paycheck tax breakdown for one associate at one pay
 * cycle: federal income tax, FICA (Social Security + Medicare with the
 * additional Medicare surcharge), state income tax, and the employer-side
 * matches that the company itself owes.
 *
 * The federal-side numbers (income-tax brackets, SS wage base, Medicare
 * surcharge threshold) are loaded from the `payroll_config` table at boot
 * — preloadPayrollTaxConfig() in lib/payrollTaxConfig wires this. SUTA
 * per-state tables, FUTA, and state income brackets stay as code constants
 * because they're not federal-annual updates and the org is FL-only.
 * Bumping a federal year is a `payroll_config` row insert, not a code edit.
 *
 * NOT a drop-in replacement for a payroll-tax SaaS like Symmetry, Avalara,
 * or Gusto Embedded; this is good enough for an internal HR platform
 * processing W-2 wages where the business has accepted the compliance
 * responsibility for keeping these tables current.
 *
 * Design choices:
 *  - Compute functions are sync. The DB-loaded config sits in a module
 *    cache so per-paycheck math doesn't pay a roundtrip. Boot preloads
 *    the current calendar year's row; tests inject via the __set helper.
 *  - Pure aside from the cache read. Callers pass in YTD snapshots and
 *    we return the breakdown — trivially testable with a fixture config.
 *  - Bi-weekly is the default pay frequency. Other frequencies need their
 *    own bracket tables; we expose `payFrequency` so future work plugs in.
 *  - State income tax uses a real progressive table for CA + NY (the two
 *    largest non-zero-tax states by associate count for hospitality/J-1),
 *    explicit zero for the nine no-SIT states, and a flat 4% fallback for
 *    everywhere else. The fallback is intentionally on the high side so
 *    we never under-withhold.
 */

/** DAILY (PAYEXP): daily pay settlements, annualized over 260 working days (Pub 15-T's daily/miscellaneous period). */
export type PayFrequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY' | 'DAILY';

// ---------- Federal income tax (IRS Pub 15-T, percentage method) -----------

interface Bracket {
  /** Lower bound of this bracket (inclusive). */
  over: number;
  /** Flat tax owed when entering this bracket. */
  flat: number;
  /** Marginal rate above `over`. */
  rate: number;
}

/**
 * In-memory snapshot of the current year's federal payroll-tax constants,
 * loaded once from the `payroll_config` table at boot. The compute
 * functions read this synchronously — preloadPayrollTaxConfig() (or the
 * test-only setter) MUST run before any compute call or they will throw.
 */
export interface PayrollTaxConfig {
  year: number;
  fedBrackets: Record<W4FilingStatus, Bracket[]>;
  ssWageBase: number;
  medicareSurchargeThreshold: number;
  /**
   * Tier-2 — {"HI": 0.045, ...}: flat withholding for states outside the
   * code tables. Consulted before the 4% blanket fallback so the long
   * tail can be tuned from data instead of a deploy.
   */
  stateFlatRates?: Record<string, number> | null;
}

let CONFIG_CACHE: PayrollTaxConfig | null = null;

type PrismaLike = Pick<PrismaClient, 'payrollConfig'>;

/**
 * Load the payroll-tax config row for `year` from the DB and cache it
 * in-process. Idempotent — replaces the cache on each call. Server boot
 * calls this once after DB warm-up; if you need a different year (e.g.,
 * backdated payroll), preload that year explicitly before the run.
 */
export async function preloadPayrollTaxConfig(
  prisma: PrismaLike,
  year: number = new Date().getFullYear(),
): Promise<void> {
  const row = await prisma.payrollConfig.findUnique({ where: { year } });
  if (!row) {
    throw new Error(
      `payrollTax: no payroll_config row for year ${year}. ` +
        'Run the add_payroll_config migration or insert the year manually.',
    );
  }
  CONFIG_CACHE = configFromRow(row);
}

/**
 * Test-only helper: set the in-memory config without a DB roundtrip.
 * Lets unit tests run without standing up a Prisma client. The leading
 * underscores are a "do not use in app code" signal.
 */
export function __setPayrollTaxConfigForTesting(cfg: PayrollTaxConfig | null): void {
  CONFIG_CACHE = cfg;
}

function configFromRow(row: {
  year: number;
  fedBracketsSingle: Prisma.JsonValue;
  fedBracketsMfj: Prisma.JsonValue;
  fedBracketsHoh: Prisma.JsonValue;
  ssWageBase: Prisma.Decimal;
  medicareSurchargeThreshold: Prisma.Decimal;
  stateFlatRates?: Prisma.JsonValue | null;
}): PayrollTaxConfig {
  return {
    year: row.year,
    fedBrackets: {
      SINGLE: row.fedBracketsSingle as unknown as Bracket[],
      MARRIED_FILING_JOINTLY: row.fedBracketsMfj as unknown as Bracket[],
      HEAD_OF_HOUSEHOLD: row.fedBracketsHoh as unknown as Bracket[],
    },
    ssWageBase: Number(row.ssWageBase),
    medicareSurchargeThreshold: Number(row.medicareSurchargeThreshold),
    stateFlatRates:
      row.stateFlatRates && typeof row.stateFlatRates === 'object'
        ? (row.stateFlatRates as Record<string, number>)
        : null,
  };
}

function getCachedConfig(): PayrollTaxConfig {
  if (!CONFIG_CACHE) {
    throw new Error(
      'payrollTax: config cache empty. Call preloadPayrollTaxConfig() at ' +
        'server boot or __setPayrollTaxConfigForTesting() in unit tests.',
    );
  }
  return CONFIG_CACHE;
}

/** Year-agnostic SS wage base, read from the cached config. */
export function SS_WAGE_BASE(): number {
  return getCachedConfig().ssWageBase;
}

/** Additional 0.9% Medicare surcharge YTD threshold (IRC §3101(b)(2)). */
export function MEDICARE_SURCHARGE_THRESHOLD(): number {
  return getCachedConfig().medicareSurchargeThreshold;
}

const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  SEMIMONTHLY: 24,
  MONTHLY: 12,
  DAILY: 260,
};

function pickBracket(table: Bracket[], annualGross: number): Bracket {
  let chosen = table[0];
  for (const b of table) {
    if (annualGross >= b.over) chosen = b;
    else break;
  }
  return chosen;
}

/**
 * Pub 15-T figures that live outside payroll_config, by tax year: the
 * Worksheet 1A line 1g amounts, the 2019-or-earlier allowance value, the
 * Step 2 checkbox rate schedules, the nonresident-alien add-ons (Tables 1
 * and 2), and the supplemental rates. A year without its own row uses the
 * latest earlier one.
 */
export interface FederalYearFigures {
  year: number;
  source: string;
  /** Worksheet 1A line 1g: subtracted when the Step 2 box is NOT checked. */
  line1g: { marriedFilingJointly: number; other: number };
  /** Worksheet 1A line 1k: per allowance on a 2019-or-earlier W-4. */
  allowance: number;
  /** Form W-4, Step 2, Checkbox, Withholding Rate Schedules. */
  checkbox: Record<W4FilingStatus, Bracket[]>;
  /** Nonresident alien add-on per pay period — Table 2 (2020+ W-4) and Table 1 (2019 or earlier). */
  nraAdd2020: Record<PayFrequency, number>;
  nraAddPre2020: Record<PayFrequency, number>;
  /** Optional flat rate on supplemental wages; mandatory rate on supplemental wages over $1M in the year. */
  supplementalRate: number;
  supplementalMandatoryRate: number;
  supplementalMandatoryOver: number;
}

export const FEDERAL_FIGURES: Record<number, FederalYearFigures> = {
  2026: {
    year: 2026,
    source: 'IRS Publication 15-T (2026): Worksheet 1A, 2026 Percentage Method Tables for Automated Payroll Systems, Tables 1 and 2; Publication 15 (2026) §7 supplemental wages',
    line1g: { marriedFilingJointly: 12_900, other: 8_600 },
    allowance: 4_300,
    checkbox: {
      MARRIED_FILING_JOINTLY: [
        { over: 0, flat: 0, rate: 0 },
        { over: 16_100, flat: 0, rate: 0.1 },
        { over: 28_500, flat: 1_240, rate: 0.12 },
        { over: 66_500, flat: 5_800, rate: 0.22 },
        { over: 121_800, flat: 17_966, rate: 0.24 },
        { over: 217_875, flat: 41_024, rate: 0.32 },
        { over: 272_325, flat: 58_448, rate: 0.35 },
        { over: 400_450, flat: 103_291.75, rate: 0.37 },
      ],
      SINGLE: [
        { over: 0, flat: 0, rate: 0 },
        { over: 8_050, flat: 0, rate: 0.1 },
        { over: 14_250, flat: 620, rate: 0.12 },
        { over: 33_250, flat: 2_900, rate: 0.22 },
        { over: 60_900, flat: 8_983, rate: 0.24 },
        { over: 108_938, flat: 20_512, rate: 0.32 },
        { over: 136_163, flat: 29_224, rate: 0.35 },
        { over: 328_350, flat: 96_489.63, rate: 0.37 },
      ],
      HEAD_OF_HOUSEHOLD: [
        { over: 0, flat: 0, rate: 0 },
        { over: 12_075, flat: 0, rate: 0.1 },
        { over: 20_925, flat: 885, rate: 0.12 },
        { over: 45_800, flat: 3_870, rate: 0.22 },
        { over: 64_925, flat: 8_077.5, rate: 0.24 },
        { over: 112_950, flat: 19_603.5, rate: 0.32 },
        { over: 140_175, flat: 28_315.5, rate: 0.35 },
        { over: 332_375, flat: 95_585.5, rate: 0.37 },
      ],
    },
    nraAdd2020: { WEEKLY: 309.6, BIWEEKLY: 619.2, SEMIMONTHLY: 670.8, MONTHLY: 1_341.7, DAILY: 61.9 },
    nraAddPre2020: { WEEKLY: 226.9, BIWEEKLY: 453.8, SEMIMONTHLY: 491.7, MONTHLY: 983.3, DAILY: 45.4 },
    supplementalRate: 0.22,
    supplementalMandatoryRate: 0.37,
    supplementalMandatoryOver: 1_000_000,
  },
};

export function federalFiguresFor(year: number = CONFIG_CACHE?.year ?? new Date().getUTCFullYear()): FederalYearFigures {
  const years = Object.keys(FEDERAL_FIGURES).map(Number).sort((a, b) => a - b);
  const pick = [...years].reverse().find((y) => y <= year) ?? years[0]!;
  return FEDERAL_FIGURES[pick]!;
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
  /** W-4 step 2(c) checkbox (two jobs): the checkbox schedules, no line 1g subtraction. */
  multipleJobs?: boolean;
  /** Allowances on a 2019-or-earlier W-4; null/undefined means a 2020-or-later W-4. */
  pre2020Allowances?: number | null;
  /** A nonresident alien employee (Pub 15-T Tables 1 and 2 add-on). */
  nonresidentAlien?: boolean;
  /** A valid "Exempt" W-4: nothing is withheld. */
  exempt?: boolean;
}

/**
 * Federal income tax for one paycheck — Pub 15-T Worksheet 1A (percentage
 * method for automated payroll systems), line for line.
 */
export function computeFederalIncomeTax(input: FederalInput): number {
  if (input.exempt) return 0;
  const figures = federalFiguresFor();
  const periods = PERIODS_PER_YEAR[input.payFrequency];
  const pre2020 = input.pre2020Allowances !== undefined && input.pre2020Allowances !== null;
  // Nonresident aliens: the Table 1/2 amount is added to wages for the calculation only.
  const nraAdd = input.nonresidentAlien ? (pre2020 ? figures.nraAddPre2020 : figures.nraAdd2020)[input.payFrequency] : 0;
  // 1a–1c: annualize this period's taxable wages.
  const annualWages = (Math.max(0, input.grossPay) + nraAdd) * periods;

  let status: W4FilingStatus = input.filingStatus ?? 'SINGLE';
  let adjusted: number;
  let table: Bracket[];
  if (pre2020) {
    // 1j–1l: less $4,300 (2026) per allowance. A 2019 W-4 has no head-of-household table.
    if (status === 'HEAD_OF_HOUSEHOLD') status = 'SINGLE';
    adjusted = Math.max(0, annualWages - Math.max(0, input.pre2020Allowances ?? 0) * figures.allowance);
    table = getCachedConfig().fedBrackets[status];
  } else {
    // 1d–1i: plus Step 4(a), less Step 4(b) and (box not checked) line 1g.
    const line1g = input.multipleJobs ? 0 : status === 'MARRIED_FILING_JOINTLY' ? figures.line1g.marriedFilingJointly : figures.line1g.other;
    adjusted = Math.max(0, annualWages + Math.max(0, input.otherIncome ?? 0) - (Math.max(0, input.deductions ?? 0) + line1g));
    table = input.multipleJobs ? figures.checkbox[status] : getCachedConfig().fedBrackets[status];
  }
  // 2a–2h: the tentative withholding per period.
  const bracket = pickBracket(table, adjusted);
  const tentative = (bracket.flat + (adjusted - bracket.over) * bracket.rate) / periods;
  // 3a–3c: Step 3 credits, per period.
  const credits = pre2020 ? 0 : Math.max(0, input.dependentsAmount ?? 0) / periods;
  const afterCredits = Math.max(0, round2(tentative) - round2(credits));
  // 4a–4b: plus Step 4(c).
  return round2(afterCredits + Math.max(0, input.extraWithholding ?? 0));
}

/**
 * Federal tax on supplemental wages identified separately from regular
 * wages (Pub 15 §7): 22% optional flat rate, and the mandatory 37% on the
 * part that takes the year's supplemental wages over $1,000,000.
 */
export function supplementalFederalWithholding(amount: number, ytdSupplementalBefore: number, year?: number): number {
  const f = federalFiguresFor(year);
  const pay = Math.max(0, amount);
  const roomBelow = Math.max(0, f.supplementalMandatoryOver - Math.max(0, ytdSupplementalBefore));
  const atFlat = Math.min(pay, roomBelow);
  return round2(atFlat * f.supplementalRate + (pay - atFlat) * f.supplementalMandatoryRate);
}

/** The W-4 columns federal withholding reads (W4Submission), plus the pay date. */
export interface FederalW4Row {
  filingStatus: W4FilingStatus;
  multipleJobs?: boolean | null;
  dependentsAmount?: unknown;
  otherIncome?: unknown;
  deductions?: unknown;
  extraWithholding?: unknown;
  exempt?: boolean | null;
  exemptTaxYear?: number | null;
  nonresidentAlien?: boolean | null;
  pre2020Allowances?: number | null;
  lockInFilingStatus?: W4FilingStatus | null;
  lockInMultipleJobs?: boolean | null;
  lockInEffectiveDate?: Date | string | null;
}

export interface FederalW4Fields {
  filingStatus: W4FilingStatus;
  multipleJobs: boolean;
  dependentsAmount: number;
  otherIncome: number;
  deductions: number;
  extraWithholding: number;
  pre2020Allowances: number | null;
  nonresidentAlien: boolean;
  exempt: boolean;
  /** What changed the employee's own W-4, for the paystub note and the readiness page. */
  flags: Array<'EXEMPT_EXPIRED' | 'LOCK_IN_LETTER'>;
}

/**
 * Read a W-4 the way withholding must on `payDate`:
 *  - An "Exempt" W-4 is good for its year and until February 15 of the
 *    next; after that, withhold as Single with no adjustments until a new
 *    one is furnished (Pub 15 §9).
 *  - An IRS lock-in letter in effect sets the filing status (and Step 2)
 *    and ignores the employee's Step 3 and 4(b) reductions; amounts that
 *    increase withholding (4(a), 4(c)) still apply (Pub 15 §9, Treas.
 *    Reg. §31.3402(f)(2)-1(g)).
 */
export function federalW4Fields(w4: FederalW4Row | null | undefined, payDate: Date = new Date()): FederalW4Fields | null {
  if (!w4) return null;
  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const flags: FederalW4Fields['flags'] = [];
  let out: FederalW4Fields = {
    filingStatus: w4.filingStatus,
    multipleJobs: !!w4.multipleJobs,
    dependentsAmount: num(w4.dependentsAmount),
    otherIncome: num(w4.otherIncome),
    deductions: num(w4.deductions),
    extraWithholding: num(w4.extraWithholding),
    pre2020Allowances: w4.pre2020Allowances ?? null,
    nonresidentAlien: !!w4.nonresidentAlien,
    exempt: !!w4.exempt,
    flags,
  };
  if (out.exempt) {
    const year = w4.exemptTaxYear ?? payDate.getUTCFullYear();
    const expires = Date.UTC(year + 1, 1, 16); // through February 15 of the next year
    if (payDate.getTime() >= expires) {
      out = { ...out, filingStatus: 'SINGLE', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, pre2020Allowances: null, exempt: false };
      flags.push('EXEMPT_EXPIRED');
    }
  }
  const lockFrom = w4.lockInEffectiveDate ? new Date(w4.lockInEffectiveDate) : null;
  if (w4.lockInFilingStatus && lockFrom && lockFrom.getTime() <= payDate.getTime()) {
    out = {
      ...out,
      filingStatus: w4.lockInFilingStatus,
      multipleJobs: w4.lockInMultipleJobs ?? out.multipleJobs,
      dependentsAmount: 0,
      deductions: 0,
      pre2020Allowances: null,
      exempt: false,
    };
    flags.push('LOCK_IN_LETTER');
  }
  return out;
}

// ---------- FICA: Social Security ------------------------------------------

export const SS_RATE = 0.062;

export interface FicaInput {
  grossPay: number;
  /** YTD wages BEFORE this paycheck. */
  ytdWages: number;
}

export function computeSocialSecurity(input: FicaInput): number {
  const remaining = Math.max(0, SS_WAGE_BASE() - input.ytdWages);
  const taxable = Math.min(input.grossPay, remaining);
  return round2(Math.max(0, taxable) * SS_RATE);
}

// ---------- Medicare ------------------------------------------------------

export const MEDICARE_RATE = 0.0145;
export const MEDICARE_SURCHARGE_RATE = 0.009;

export interface MedicareInput {
  grossPay: number;
  /** YTD Medicare wages BEFORE this paycheck (no cap, unlike SS). */
  ytdMedicareWages: number;
}

export function computeMedicare(input: MedicareInput): number {
  const base = input.grossPay * MEDICARE_RATE;
  // Additional 0.9% on the portion of YTD+current that exceeds the threshold.
  const after = input.ytdMedicareWages + input.grossPay;
  const threshold = MEDICARE_SURCHARGE_THRESHOLD();
  let surcharge = 0;
  if (after > threshold) {
    const overflow = Math.min(input.grossPay, after - threshold);
    surcharge = overflow * MEDICARE_SURCHARGE_RATE;
  }
  return round2(base + surcharge);
}

// ---------- State income tax ----------------------------------------------

/** States that levy no income tax (TN/NH dropped their interest+dividend tax in 2021/2025). */
export const NO_SIT_STATES = new Set([
  'FL', 'TX', 'NV', 'WA', 'AK', 'SD', 'WY', 'TN', 'NH',
]);



/**
 * Flat-rate states with no deduction or allowance. Empty since the 2026
 * methods (lib/stateWithholding2026.ts) replaced IL, PA, MI, MA, CO, AZ,
 * KY, IN, NC, UT and ID; kept as the shape for any future one-number state.
 */
const FLAT_STATE_RATES_2024: Record<string, number> = {};

/**
 * Map of supported bracketed-state tables. Adding a new state = drop a
 * Bracket[] above and add it here.
 */
const BRACKET_STATES_2024: Record<string, Bracket[]> = {};

/**
 * There is no flat-rate fallback any more. A state with no table here and
 * no configured rate withholds nothing, and the payroll exceptions flag
 * the person as BLOCKING (UNSUPPORTED_STATE) so the run cannot finalize
 * with them in it — a guessed 4% was a liability dressed as a feature.
 * `supportedStates()` lists what is covered, for the exception message
 * and the readiness page.
 */

export interface StateInput {
  grossPay: number;
  /** Two-letter state code, uppercased. null → use fallback. */
  state: string | null;
  payFrequency: PayFrequency;
  /** The state's own withholding certificate (AL A-4, MD MW507 …), when on file. */
  stateW4?: StateW4Input | null;
  /** The federal W-4 filing status — the state default when no certificate. */
  federalFilingStatus?: W4FilingStatus | null;
  /** This cycle's federal withholding — AL and OR subtract it. */
  federalCycleWithholding?: number;
}

export function computeStateIncomeTax(input: StateInput): number {
  const state = input.state?.toUpperCase().trim() ?? null;
  if (state && NO_SIT_STATES.has(state)) return 0;

  if (state) {
    // 2026 methods for the always-covered states (lib/stateWithholding2026.ts).
    const verified = VERIFIED_STATE_SPECS[state];
    if (verified) {
      return stateCycleWithholding(verified, {
        cycleWages: input.grossPay,
        periods: PERIODS_PER_YEAR[input.payFrequency],
        federalFilingStatus: input.federalFilingStatus ?? null,
        federalCycleWithholding: input.federalCycleWithholding ?? 0,
        stateW4: input.stateW4 ?? null,
      });
    }

    const flat = FLAT_STATE_RATES_2024[state];
    if (flat !== undefined) return round2(input.grossPay * flat);

    const table = BRACKET_STATES_2024[state];
    if (table) {
      const periods = PERIODS_PER_YEAR[input.payFrequency];
      const annualGross = input.grossPay * periods;
      return annualToCycle(table, annualGross, periods);
    }

    // Tier-2 — config-driven long-tail rates before the blanket fallback.
    const configured = CONFIG_CACHE?.stateFlatRates?.[state];
    if (typeof configured === 'number' && configured >= 0 && configured < 1) {
      return round2(input.grossPay * configured);
    }

    // TAXCOMP — the states added from their published methods. They compute
    // here whether or not they are acknowledged; until a payroll admin
    // records the review, payrollExceptions blocks the run (UNSUPPORTED_STATE).
    const spec = STATE_SPECS[state];
    if (spec) {
      return stateCycleWithholding(spec, {
        cycleWages: input.grossPay,
        periods: PERIODS_PER_YEAR[input.payFrequency],
        federalFilingStatus: input.federalFilingStatus ?? null,
        federalCycleWithholding: input.federalCycleWithholding ?? 0,
        stateW4: input.stateW4 ?? null,
      });
    }
  }

  // Not covered: nothing is withheld, and the run is blocked upstream
  // (lib/payrollExceptions.ts UNSUPPORTED_STATE) until the state is.
  return 0;
}

/**
 * TAXCOMP — which of the added states each tenant's payroll admin has
 * acknowledged ("reviewed with our tax adviser"), and for which tax year.
 * Primed per tenant by primeStateAcknowledgments() before any coverage
 * check (the exceptions, finalize and readiness paths call it), so the sync
 * checks below can read it.
 */
const ACK_CACHE = new Map<string, Map<string, number>>();
const tenantKey = () => currentTenantId() ?? '00000000-0000-4000-8000-000000000001';

type AckDb = { stateTaxAcknowledgment: { findMany: (args: { where: { tenantId: string } }) => Promise<Array<{ state: string; taxYear: number }>> } };

export async function primeStateAcknowledgments(db: AckDb): Promise<void> {
  const key = tenantKey();
  const rows = await db.stateTaxAcknowledgment.findMany({ where: { tenantId: key } });
  ACK_CACHE.set(key, new Map(rows.map((r) => [r.state.toUpperCase(), r.taxYear])));
}

/** Test-only: forget every tenant's acknowledgments. */
export function __resetStateAcknowledgmentsForTesting(): void {
  ACK_CACHE.clear();
}

/** An added state awaiting its review for this tenant (null when not an added state). */
export function stateAwaitingReview(state: string | null): { state: string; name: string; taxYear: number } | null {
  if (!state) return null;
  const s = state.toUpperCase().trim();
  const spec = STATE_SPECS[s];
  if (!spec) return null;
  const acked = ACK_CACHE.get(tenantKey())?.get(s);
  return acked === spec.taxYear ? null : { state: s, name: spec.name, taxYear: spec.taxYear };
}

function isVerifiedState(s: string): boolean {
  return (
    NO_SIT_STATES.has(s) ||
    s in VERIFIED_STATE_SPECS ||
    s in FLAT_STATE_RATES_2024 ||
    s in BRACKET_STATES_2024 ||
    typeof CONFIG_CACHE?.stateFlatRates?.[s] === 'number'
  );
}

/** Every state the engine withholds for, sorted — no-tax states and acknowledged added states included. */
export function supportedStates(): string[] {
  const configured = Object.entries(CONFIG_CACHE?.stateFlatRates ?? {})
    .filter(([, v]) => typeof v === 'number')
    .map(([k]) => k.toUpperCase());
  const acknowledged = Object.keys(STATE_SPECS).filter((s) => !stateAwaitingReview(s));
  return [...new Set([...NO_SIT_STATES, ...Object.keys(VERIFIED_STATE_SPECS), ...Object.keys(FLAT_STATE_RATES_2024), ...Object.keys(BRACKET_STATES_2024), ...configured, ...acknowledged])].sort();
}

/** True if `state` has a real (non-fallback) tax model this tenant may withhold
 *  with — an added state only once acknowledged. Surfaced for the payroll
 *  wizard's state-coverage badge. */
export function isStateTaxSupported(state: string | null): boolean {
  if (!state) return false;
  const s = state.toUpperCase().trim();
  if (isVerifiedState(s)) return true;
  return s in STATE_SPECS && !stateAwaitingReview(s);
}

/** The engine's view of one state, for the coverage page. */
export function stateCoverageOf(state: string): 'verified' | 'acknowledged' | 'awaiting_review' | 'none' {
  const s = state.toUpperCase().trim();
  if (isVerifiedState(s)) return 'verified';
  if (s in STATE_SPECS) return stateAwaitingReview(s) ? 'awaiting_review' : 'acknowledged';
  return 'none';
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

/**
 * FUTA credit reductions: a state that hasn't repaid its federal UI loan
 * loses part of the 5.4% credit, so FUTA on wages there costs more. The
 * Department of Labor sets the year's list on November 10 (final) after a
 * potential list in January. Applied to the employer FUTA accrual and the
 * Form 940 Schedule A.
 */
export const FUTA_CREDIT_REDUCTION: Record<number, { states: Record<string, number>; final: boolean; source: string }> = {
  2025: {
    states: { CA: 0.012, VI: 0.045 },
    final: true,
    source: 'U.S. DOL, FUTA credit reductions for 2025 (determined November 10, 2025): California 1.2%, U.S. Virgin Islands 4.5%; CT and NY repaid (0.0%)',
  },
  2026: {
    // CONFIRM WITH U.S. DOL: the 2026 list is final after November 10, 2026.
    // The potential list names California at 1.5% (3.8% more if its BCR
    // add-on waiver is refused) and the U.S. Virgin Islands; California is
    // accrued at 1.5% now so the year-end 940 isn't a surprise.
    states: { CA: 0.015 },
    final: false,
    source: 'U.S. DOL, potential FUTA credit reduction states for 2026 (California 1.5%, U.S. Virgin Islands), APA news 2026-04-07; CONFIRM after the November 10, 2026 determination',
  },
};

export function futaCreditReduction(state: string | null | undefined, year: number = CONFIG_CACHE?.year ?? new Date().getUTCFullYear()): number {
  const key = (state ?? '').toUpperCase().trim();
  return FUTA_CREDIT_REDUCTION[year]?.states[key] ?? 0;
}

/**
 * Wave 2.3 — Per-state SUTA wage bases and new-employer rates for 2024.
 *
 * Source: each state UI agency's published rate schedule. New-employer
 * rates are defaults the state assigns to a brand-new employer's experience
 * rating — every employer's actual rate diverges over time as their layoff
 * history accumulates. HR can override per-client in a future Wave when
 * the real rates land via the state agency notice.
 *
 * For states absent from this table, we fall back to the FUTA wage base
 * ($7000) and a conservative 2.7% rate.
 */
const SUTA_2024: Record<string, { wageBase: number; rate: number }> = {
  AL: { wageBase: 8_000,  rate: 0.027 },
  AK: { wageBase: 49_700, rate: 0.0227 },
  AZ: { wageBase: 8_000,  rate: 0.02 },
  AR: { wageBase: 7_000,  rate: 0.021 },
  CA: { wageBase: 7_000,  rate: 0.034 },
  CO: { wageBase: 23_800, rate: 0.0117 },
  CT: { wageBase: 25_000, rate: 0.027 },
  DE: { wageBase: 12_500, rate: 0.013 },
  FL: { wageBase: 7_000,  rate: 0.0270 },
  GA: { wageBase: 9_500,  rate: 0.0264 },
  HI: { wageBase: 59_100, rate: 0.04 },
  ID: { wageBase: 53_500, rate: 0.01 },
  IL: { wageBase: 13_590, rate: 0.0395 },
  IN: { wageBase: 9_500,  rate: 0.025 },
  IA: { wageBase: 38_200, rate: 0.01 },
  KS: { wageBase: 14_000, rate: 0.0275 },
  KY: { wageBase: 11_400, rate: 0.027 },
  LA: { wageBase: 7_700,  rate: 0.011 },
  ME: { wageBase: 12_000, rate: 0.0225 },
  MD: { wageBase: 8_500,  rate: 0.026 },
  MA: { wageBase: 15_000, rate: 0.0224 },
  MI: { wageBase: 9_500,  rate: 0.027 },
  MN: { wageBase: 42_000, rate: 0.01 },
  MS: { wageBase: 14_000, rate: 0.012 },
  MO: { wageBase: 10_000, rate: 0.0151 },
  MT: { wageBase: 43_000, rate: 0.01 },
  NE: { wageBase: 9_000,  rate: 0.0125 },
  NV: { wageBase: 40_600, rate: 0.0295 },
  NH: { wageBase: 14_000, rate: 0.027 },
  NJ: { wageBase: 42_300, rate: 0.028 },
  NM: { wageBase: 31_700, rate: 0.01 },
  NY: { wageBase: 12_500, rate: 0.041 },
  NC: { wageBase: 31_400, rate: 0.01 },
  ND: { wageBase: 43_800, rate: 0.0102 },
  OH: { wageBase: 9_000,  rate: 0.027 },
  OK: { wageBase: 27_000, rate: 0.015 },
  OR: { wageBase: 52_800, rate: 0.024 },
  PA: { wageBase: 10_000, rate: 0.03689 },
  RI: { wageBase: 29_200, rate: 0.0098 },
  SC: { wageBase: 14_000, rate: 0.0061 },
  SD: { wageBase: 15_000, rate: 0.012 },
  TN: { wageBase: 7_000,  rate: 0.027 },
  TX: { wageBase: 9_000,  rate: 0.027 },
  UT: { wageBase: 47_000, rate: 0.014 },
  VT: { wageBase: 14_300, rate: 0.01 },
  VA: { wageBase: 8_000,  rate: 0.0273 },
  WA: { wageBase: 68_500, rate: 0.0114 },
  WV: { wageBase: 9_500,  rate: 0.027 },
  WI: { wageBase: 14_000, rate: 0.034 },
  WY: { wageBase: 30_900, rate: 0.0072 },
  DC: { wageBase: 9_000,  rate: 0.027 },
};

/** A state's default unemployment wage base and new-employer rate (the employer's own assigned rate overrides it). */
export function sutaDefaults(state: string | null | undefined): { wageBase: number; rate: number } | null {
  const key = (state ?? '').toUpperCase().trim();
  return SUTA_2024[key] ?? null;
}

export interface EmployerInput {
  grossPay: number;
  ytdWages: number;
  ytdMedicareWages: number;
  /** Wave 2.3 — drives per-state SUTA wage base + rate. */
  state?: string | null;
  /**
   * Tier-2 — the employer's actual experience rate from the state
   * agency's annual notice (per-client override). Beats the
   * new-employer default table when present; a null wageBase keeps the
   * state table's base.
   */
  sutaOverride?: { rate: number; wageBase: number | null } | null;
}

export interface EmployerBreakdown {
  fica: number; // 6.2% match, capped at SS wage base
  medicare: number; // 1.45% match, no surcharge match (employer doesn't owe additional)
  futa: number;
  /** Per-state SUTA. See SUTA_2024 for wage base + new-employer rate. */
  suta: number;
}

export function computeEmployerTaxes(input: EmployerInput): EmployerBreakdown {
  const ssRemaining = Math.max(0, SS_WAGE_BASE() - input.ytdWages);
  const ssTaxable = Math.min(input.grossPay, ssRemaining);
  const fica = round2(ssTaxable * SS_RATE);

  const medicare = round2(input.grossPay * MEDICARE_RATE);

  const futaRemaining = Math.max(0, FUTA_WAGE_BASE - input.ytdWages);
  const futaTaxable = Math.min(input.grossPay, futaRemaining);
  const stateKey = input.state?.toUpperCase().trim();
  // Credit-reduction states pay more FUTA on wages there.
  const futa = round2(futaTaxable * (FUTA_RATE_NET + futaCreditReduction(stateKey)));

  const stateCfg =
    stateKey && SUTA_2024[stateKey]
      ? SUTA_2024[stateKey]
      : { wageBase: FUTA_WAGE_BASE, rate: 0.027 };
  const sutaCfg = input.sutaOverride
    ? {
        rate: input.sutaOverride.rate,
        wageBase: input.sutaOverride.wageBase ?? stateCfg.wageBase,
      }
    : stateCfg;
  const suta = sutaFor(sutaCfg, input.grossPay, input.ytdWages);

  return { fica, medicare, futa, suta };
}

function sutaFor(
  cfg: { wageBase: number; rate: number },
  grossPay: number,
  ytdWages: number
): number {
  const remaining = Math.max(0, cfg.wageBase - ytdWages);
  const taxable = Math.min(grossPay, remaining);
  return round2(taxable * cfg.rate);
}

// ---------- Aggregate ------------------------------------------------------

export interface PaycheckTaxInput {
  /**
   * Wages used for FIT + state income tax. Net of all pre-tax deductions
   * (Section 125, HSA, FSA, AND traditional 401(k)/403(b)). This is the
   * Box 1 base on the W-2.
   */
  grossPay: number;
  /**
   * Wages used for FICA (Social Security) + Medicare. Net of Section 125
   * + HSA + FSA only — does NOT subtract retirement contributions, since
   * 401(k)/403(b) are FIT-deferred but FICA-includable. Defaults to
   * grossPay for back-compat (callers that don't have a retirement
   * bucket) — equivalent to "no retirement deduction in this paycheck."
   * This is the Box 3 / Box 5 base on the W-2.
   */
  ficaMedicareGross?: number;
  filingStatus: W4FilingStatus | null;
  payFrequency: PayFrequency;
  state: string | null;
  ytdWages: number;
  ytdMedicareWages: number;
  extraWithholding?: number;
  deductions?: number;
  otherIncome?: number;
  dependentsAmount?: number;
  /** Tier-2 — per-client SUTA experience-rate override, passed through
   *  to computeEmployerTaxes. */
  sutaOverride?: { rate: number; wageBase: number | null } | null;
  /** TAXCOMP — the state withholding certificate for `state`, when on file. */
  stateW4?: StateW4Input | null;
  /** W-4 Step 2 checkbox; a 2019-or-earlier W-4's allowances; NRA; exempt (see federalW4Fields). */
  multipleJobs?: boolean;
  pre2020Allowances?: number | null;
  nonresidentAlien?: boolean;
  exempt?: boolean;
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
  // FICA + Medicare base falls back to FIT base when caller didn't split
  // — keeps every existing call site working unchanged.
  const ficaGross = input.ficaMedicareGross ?? input.grossPay;
  const fit = computeFederalIncomeTax(input);
  const ss = computeSocialSecurity({ grossPay: ficaGross, ytdWages: input.ytdWages });
  const med = computeMedicare({
    grossPay: ficaGross,
    ytdMedicareWages: input.ytdMedicareWages,
  });
  const sit = computeStateIncomeTax({
    grossPay: input.grossPay,
    state: input.state,
    payFrequency: input.payFrequency,
    stateW4: input.stateW4 ?? null,
    federalFilingStatus: input.filingStatus,
    // AL and OR subtract federal tax; the W-4 4(c) extra is not a tax estimate.
    federalCycleWithholding: Math.max(0, fit - Math.max(0, input.extraWithholding ?? 0)),
  });
  const totalEmployeeTax = round2(fit + ss + med + sit);
  // Net is computed against the FIT base because that's the actual cash
  // hitting the bank — FICA-only-includable retirement contributions are
  // already withheld from the same gross. Using grossPay (= FIT base)
  // here preserves the prior contract.
  const netPay = round2(input.grossPay - totalEmployeeTax);
  const employer = computeEmployerTaxes({
    // Employer FICA/Medicare/FUTA/SUTA all match the employee FICA base.
    grossPay: ficaGross,
    ytdWages: input.ytdWages,
    ytdMedicareWages: input.ytdMedicareWages,
    state: input.state,
    sutaOverride: input.sutaOverride ?? null,
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
