/**
 * State withholding for the states and DC the original engine left out
 * (TAXCOMP 2026-10): AL AR CT DE DC HI IA KS LA ME MD MO MS MT NE NM ND OK
 * OR RI SC VT WV WI.
 *
 * Each state is an annualized percentage-method computation — annual wages
 * less the state's standard deduction / exemptions, through its brackets,
 * less per-allowance credits — divided back to the pay period. The figures
 * were transcribed from each revenue department's published withholding
 * method for the tax year named on the spec, and NOT independently
 * verified: every spec carries `verified: false`, and lib/payrollTax.ts
 * refuses to treat the state as covered until a payroll admin records
 * "reviewed with our tax adviser" for that state and tax year
 * (StateTaxAcknowledgment). `confidence` says how sure the transcription
 * is — 'low' means the state's own withholding formula has wrinkles this
 * model approximates (credits, phase-outs, sliding deductions) and should
 * be checked against the state's calculator before acknowledging.
 *
 * Mandatory local taxes are folded in where they ride on the state
 * computation: Maryland's county income tax (by the MW507 county) and
 * Oregon's statewide transit tax (0.1% of wages).
 */

export type StateFilingStatus = 'SINGLE' | 'MARRIED' | 'HEAD_OF_HOUSEHOLD';

export interface StateCalcInput {
  /** Annualized wages subject to state income tax (pre-tax deductions out). */
  annualWages: number;
  filingStatus: StateFilingStatus;
  /** Allowances / exemptions claimed on the state certificate (total). */
  allowances: number;
  dependents: number;
  /** Annualized federal income tax withheld — AL and OR subtract it. */
  annualFederalWithholding: number;
  /** Maryland county of residence (MW507). */
  county?: string | null;
  /** The certificate's own status code as entered (CT-W4 "A"…"F", AL A-4 "0"/"S"/"M"…), for states whose codes aren't a filing status. */
  rawStatus?: string | null;
  /** A state certificate is on file (CT withholds at Code D, the highest, without one). */
  hasCertificate?: boolean;
}

export interface StateWithholdingSpec {
  state: string;
  name: string;
  taxYear: number;
  /** Where the method was read from. */
  source: string;
  confidence: 'medium' | 'low';
  /** The state's own withholding certificate, when it has one. */
  form: string | null;
  /** False until independently verified; see the module comment. */
  verified: boolean;
  /** Annual tax (state + mandatory local riding on it). */
  annualTax(input: StateCalcInput): number;
  /** Plain-language notes shown on the coverage page. */
  notes?: string;
}

type Tier = [upTo: number, rate: number];

/** Progressive tax over `taxable`; the last tier's upTo is Infinity. */
export function progressive(taxable: number, tiers: Tier[]): number {
  if (taxable <= 0) return 0;
  let tax = 0;
  let floor = 0;
  for (const [upTo, rate] of tiers) {
    if (taxable <= floor) break;
    const slice = Math.min(taxable, upTo) - floor;
    if (slice > 0) tax += slice * rate;
    floor = upTo;
  }
  return tax;
}

const I = Infinity;
const pos = (n: number) => Math.max(0, n);
const byStatus = <T,>(s: StateFilingStatus, single: T, married: T, hoh: T = single): T =>
  s === 'MARRIED' ? married : s === 'HEAD_OF_HOUSEHOLD' ? hoh : single;

/** Scale a single-filer tier table for married filers (most states double it). */
const doubled = (tiers: Tier[]): Tier[] => tiers.map(([u, r]) => [u === I ? I : u * 2, r]);

// 2025 federal standard deduction — several states adopt it for withholding.
const FED_STD_2025 = (s: StateFilingStatus) => byStatus(s, 15_000, 30_000, 22_500);

/** Maryland county rates now live with the 2026 Maryland method (lib/stateWithholding2026.ts). */
export { MD_COUNTY_RATES_2026 as MD_COUNTY_RATES_2025 } from './stateWithholding2026.js';
import { MD_COUNTY_RATES_2026 } from './stateWithholding2026.js';
/** Used when the MW507 names no county — the guide's "Unknown Maryland" rate. */
export const MD_DEFAULT_COUNTY_RATE = 0.033;

export function mdCountyRate(county: string | null | undefined): { rate: number; known: boolean } {
  const key = county?.trim().toUpperCase();
  if (key && key in MD_COUNTY_RATES_2026) return { rate: MD_COUNTY_RATES_2026[key]!, known: true };
  return { rate: MD_DEFAULT_COUNTY_RATE, known: false };
}





export const STATE_SPECS: Record<string, StateWithholdingSpec> = {

  AR: {
    state: 'AR', name: 'Arkansas', taxYear: 2026, confidence: 'low', form: 'AR4EC', verified: false,
    source: 'Arkansas DFA, Withholding Tax Formula (2026): standard deduction $2,470, $29 per exemption; top rate 3.7% retroactive to January 1, 2026',
    notes: 'Standard deduction $2,470; $29 personal tax credit per exemption; top rate 3.7%. The state formula also has a low-income table this model does not reproduce.',
    annualTax: ({ annualWages: w, allowances }) => {
      const taxable = w - 2_470;
      // CONFIRM WITH Arkansas DFA: the 2026 band edges below the top rate.
      const tax = progressive(taxable, [[5_499, 0], [10_899, 0.02], [15_599, 0.03], [25_699, 0.034], [I, 0.037]]);
      return pos(tax - 29 * allowances);
    },
  },


  DE: {
    state: 'DE', name: 'Delaware', taxYear: 2025, confidence: 'medium', form: null, verified: false,
    source: 'Delaware Division of Revenue, Withholding Tax Tables and Formula (2025)',
    notes: 'Standard deduction $3,250 ($6,500 married filing jointly); $110 credit per exemption.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - byStatus(s, 3_250, 6_500, 3_250);
      const tax = progressive(taxable, [[2_000, 0], [5_000, 0.022], [10_000, 0.039], [20_000, 0.048], [25_000, 0.052], [60_000, 0.0555], [I, 0.066]]);
      return pos(tax - 110 * allowances);
    },
  },
  DC: {
    state: 'DC', name: 'District of Columbia', taxYear: 2025, confidence: 'medium', form: 'D-4', verified: false,
    source: 'DC OTR, Income Tax Withholding Instructions and Tables (2025)',
    notes: 'Standard deduction follows the federal amount; brackets 4%–10.75%.',
    annualTax: ({ annualWages: w, filingStatus: s }) => {
      const taxable = w - FED_STD_2025(s);
      return progressive(taxable, [[10_000, 0.04], [40_000, 0.06], [60_000, 0.065], [250_000, 0.085], [500_000, 0.0925], [1_000_000, 0.0975], [I, 0.1075]]);
    },
  },



  LA: {
    state: 'LA', name: 'Louisiana', taxYear: 2026, confidence: 'medium', form: 'L-4', verified: false,
    source: 'Louisiana LDR, emergency rule LAC 61:I.1501 (December 23, 2025) and RIB 26-005: 2026 standard deduction $12,875 / $25,750, withholding rate 3.09%',
    notes: 'Flat 3.09% after the standard deduction ($12,875 single or married separate, $25,750 otherwise).',
    annualTax: ({ annualWages: w, filingStatus: s }) => pos(w - byStatus(s, 12_875, 25_750, 25_750)) * 0.0309,
  },

  ME: {
    state: 'ME', name: 'Maine', taxYear: 2026, confidence: 'medium', form: 'W-4ME', verified: false,
    source: 'Maine Revenue Services, 2026 Withholding Tables for Individual Income Tax (personal exemption $5,300; standard deduction $15,300 / $30,600) — CONFIRM WITH Maine Revenue Services: the 2026 percentage-method bracket edges',
    notes: 'Standard deduction $15,300 single / $30,600 married; $5,300 per allowance; brackets 5.8% / 6.75% / 7.15%.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - byStatus(s, 15_300, 30_600, 22_950) - allowances * 5_300;
      const single: Tier[] = [[26_800, 0.058], [63_450, 0.0675], [I, 0.0715]];
      const hoh: Tier[] = [[40_200, 0.058], [95_150, 0.0675], [I, 0.0715]];
      return progressive(taxable, byStatus(s, single, doubled(single), hoh));
    },
  },



  MS: {
    state: 'MS', name: 'Mississippi', taxYear: 2026, confidence: 'medium', form: '89-350', verified: false,
    source: 'Mississippi DOR, Withholding Tax Formula; HB 1 (2025) sets the 2026 rate at 4.0% above $10,000',
    notes: 'Standard deduction and exemptions by status, $1,500 per dependent; 0% on the first $10,000, 4.0% above.',
    annualTax: ({ annualWages: w, filingStatus: s, dependents }) => {
      const taxable = w - byStatus(s, 2_300, 4_600, 3_400) - byStatus(s, 6_000, 12_000, 9_500) - dependents * 1_500;
      return progressive(taxable, [[10_000, 0], [I, 0.04]]);
    },
  },
  MT: {
    state: 'MT', name: 'Montana', taxYear: 2026, confidence: 'low', form: 'MW-4', verified: false,
    source: 'Montana DOR, Withholding Tax Guide; HB 337 (2025) brackets and rates for 2026',
    notes: 'Two brackets (4.7% / 5.65%); standard deduction follows the federal amount.',
    annualTax: ({ annualWages: w, filingStatus: s }) => {
      const cut = byStatus(s, 47_500, 95_000, 71_250);
      return progressive(w - FED_STD_2025(s), [[cut, 0.047], [I, 0.0565]]);
    },
  },

  NM: {
    state: 'NM', name: 'New Mexico', taxYear: 2025, confidence: 'medium', form: null, verified: false,
    source: 'NM Taxation and Revenue, FYI-104 withholding tables (2025) — HB 252 (2024) brackets',
    notes: 'Uses the federal W-4; standard deduction follows the federal amount.',
    annualTax: ({ annualWages: w, filingStatus: s }) => {
      const single: Tier[] = [[5_500, 0.015], [16_500, 0.032], [33_500, 0.043], [66_500, 0.047], [210_000, 0.049], [I, 0.059]];
      const married: Tier[] = [[8_000, 0.015], [25_000, 0.032], [50_000, 0.043], [100_000, 0.047], [315_000, 0.049], [I, 0.059]];
      return progressive(w - FED_STD_2025(s), s === 'MARRIED' ? married : single);
    },
  },

  OK: {
    state: 'OK', name: 'Oklahoma', taxYear: 2026, confidence: 'medium', form: 'OK-W-4', verified: false,
    source: 'Oklahoma Tax Commission, Packet OW-2 (revised November 2025, effective January 1, 2026) — HB 2764 (2025): three brackets, top rate 4.5%',
    notes: '$1,000 per allowance; the standard deduction is built into the 0% band (single/HOH $10,100, married $20,200 annual).',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - allowances * 1_000;
      const single: Tier[] = [[10_100, 0], [11_250, 0.025], [13_550, 0.035], [I, 0.045]];
      // CONFIRM WITH Oklahoma Tax Commission: the married bands (single bands' statutory brackets doubled plus the $12,700 deduction).
      const married: Tier[] = [[20_200, 0], [22_500, 0.025], [27_100, 0.035], [I, 0.045]];
      return progressive(taxable, s === 'MARRIED' ? married : single);
    },
  },



  SC: {
    state: 'SC', name: 'South Carolina', taxYear: 2026, confidence: 'medium', form: 'SC W-4', verified: false,
    source: 'SC DOR, Withholding Tax Formula WH-1603 (2026): top rate 6.0%, $5,000 per allowance, standard deduction 10% of wages up to $7,500',
    notes: 'Standard deduction (10% of wages, up to $7,500) when allowances are claimed; $5,000 per allowance; 0% / 3% / 6.0%.',
    annualTax: ({ annualWages: w, allowances }) => {
      const std = allowances > 0 ? Math.min(0.1 * w, 7_500) : 0;
      // CONFIRM WITH SC DOR: the 0% and 3% band edges ($3,560, $17,830 in 2025) for 2026.
      return progressive(w - std - allowances * 5_000, [[3_560, 0], [17_830, 0.03], [I, 0.06]]);
    },
  },


  WV: {
    state: 'WV', name: 'West Virginia', taxYear: 2026, confidence: 'medium', form: 'WV/IT-104', verified: false,
    source: 'WV Tax Division, withholding tables effective June 12, 2026 (SB 392, retroactive to January 1, 2026)',
    notes: '$2,000 per exemption; brackets 2.11%–4.58%.',
    annualTax: ({ annualWages: w, allowances }) =>
      progressive(w - allowances * 2_000, [[10_000, 0.0211], [25_000, 0.0281], [40_000, 0.0316], [60_000, 0.0422], [I, 0.0458]]),
  },

  WI: {
    state: 'WI', name: 'Wisconsin', taxYear: 2026, confidence: 'low', form: 'WT-4', verified: false,
    source: 'Wisconsin DOR, Publication W-166 (effective 1/1/26) Method B — CONFIRM WITH Wisconsin DOR: standard deduction $6,702 single (phasing out 12% above $17,780) / $9,461 married, $400 per exemption, 3.54% / 4.65% / 5.30% / 7.65% at $12,760 / $25,520 / $280,950',
    notes: 'Sliding standard deduction, $400 per exemption; withholding rates 3.54%–7.65%.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const std = s === 'MARRIED' ? (w < 25_727 ? 9_461 : w >= 73_032 ? 0 : pos(9_461 - (9_461 * (w - 25_727)) / (73_032 - 25_727))) : (w < 17_780 ? 6_702 : w >= 73_630 ? 0 : pos(6_702 - 0.12 * (w - 17_780)));
      return progressive(w - std - allowances * 400, [[12_760, 0.0354], [25_520, 0.0465], [280_950, 0.053], [I, 0.0765]]);
    },
  },

};

export const NEW_STATES = Object.keys(STATE_SPECS).sort();

export interface StateW4Input {
  filingStatus: string;
  allowances: number;
  dependents: number;
  additionalWithholding: number;
  exempt: boolean;
  county?: string | null;
}

/** Normalize a state certificate (or the federal filing status) to the calculator's terms. */
export function stateFilingStatus(raw: string | null | undefined): StateFilingStatus {
  const s = (raw ?? '').toUpperCase();
  if (s.startsWith('MARRIED')) return 'MARRIED';
  if (s.startsWith('HEAD')) return 'HEAD_OF_HOUSEHOLD';
  return 'SINGLE';
}

/**
 * Per-cycle withholding for one of the new states. Exempt certificates
 * withhold nothing; extra withholding on the certificate is added as is.
 */
export function stateCycleWithholding(
  spec: Pick<StateWithholdingSpec, 'annualTax'>,
  input: { cycleWages: number; periods: number; federalFilingStatus: string | null; federalCycleWithholding: number; stateW4?: StateW4Input | null },
): number {
  const w4 = input.stateW4 ?? null;
  if (w4?.exempt) return 0;
  const annual = spec.annualTax({
    annualWages: input.cycleWages * input.periods,
    filingStatus: stateFilingStatus(w4?.filingStatus ?? input.federalFilingStatus),
    allowances: Math.max(0, w4?.allowances ?? 0),
    dependents: Math.max(0, w4?.dependents ?? 0),
    annualFederalWithholding: input.federalCycleWithholding * input.periods,
    county: w4?.county ?? null,
    rawStatus: w4?.filingStatus ?? null,
    hasCertificate: !!w4,
  });
  const cycle = Math.max(0, annual) / input.periods + Math.max(0, w4?.additionalWithholding ?? 0);
  return Math.round(cycle * 100) / 100;
}
