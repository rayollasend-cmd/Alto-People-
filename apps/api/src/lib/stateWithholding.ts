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
  verified: false;
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

/**
 * Maryland county income tax rates (2025, Comptroller of Maryland local
 * rate table). Anne Arundel and Frederick have bracketed local rates; the
 * single-filer marginal rate for typical hourly wages is used here.
 */
export const MD_COUNTY_RATES_2025: Record<string, number> = {
  ALLEGANY: 0.0303,
  'ANNE ARUNDEL': 0.027,
  'BALTIMORE CITY': 0.032,
  'BALTIMORE COUNTY': 0.032,
  CALVERT: 0.03,
  CAROLINE: 0.032,
  CARROLL: 0.0303,
  CECIL: 0.0274,
  CHARLES: 0.0303,
  DORCHESTER: 0.033,
  FREDERICK: 0.0275,
  GARRETT: 0.0265,
  HARFORD: 0.0306,
  HOWARD: 0.032,
  KENT: 0.032,
  MONTGOMERY: 0.032,
  "PRINCE GEORGE'S": 0.032,
  "QUEEN ANNE'S": 0.032,
  "ST. MARY'S": 0.03,
  SOMERSET: 0.032,
  TALBOT: 0.024,
  WASHINGTON: 0.0295,
  WICOMICO: 0.032,
  WORCESTER: 0.0225,
};
/** Used when the MW507 names no county — the most common county rate. */
export const MD_DEFAULT_COUNTY_RATE = 0.032;

export function mdCountyRate(county: string | null | undefined): { rate: number; known: boolean } {
  const key = county?.trim().toUpperCase();
  if (key && key in MD_COUNTY_RATES_2025) return { rate: MD_COUNTY_RATES_2025[key]!, known: true };
  return { rate: MD_DEFAULT_COUNTY_RATE, known: false };
}

/** Alabama's sliding standard deduction (Ala. Code §40-18-15(a)(1)). */
function alStdDeduction(agi: number, s: StateFilingStatus): number {
  const [max, step, min] = byStatus(s, [3_000, 25, 2_500] as const, [8_500, 175, 5_000] as const, [5_200, 135, 2_600] as const);
  if (agi <= 23_499) return max;
  const steps = Math.ceil((agi - 23_499) / 500);
  return Math.max(min, max - steps * step);
}

/** Wisconsin's sliding standard deduction used by its withholding method. */
function wiStdDeduction(wages: number, s: StateFilingStatus): number {
  if (s === 'MARRIED') return wages <= 25_840 ? 23_620 : pos(23_620 - 0.19778 * (wages - 25_840));
  return wages <= 17_780 ? 12_760 : pos(12_760 - 0.12 * (wages - 17_780));
}

/** Connecticut's personal exemption with its income phase-out. */
function ctExemption(wages: number, s: StateFilingStatus): number {
  const [max, start] = byStatus(s, [15_000, 30_000] as const, [24_000, 48_000] as const, [19_000, 38_000] as const);
  if (wages <= start) return max;
  return pos(max - Math.ceil((wages - start) / 1_000) * 1_000);
}

/** Oregon's federal tax subtraction, capped and phased out at higher incomes. */
function orFederalSubtraction(wages: number, fed: number, s: StateFilingStatus): number {
  const [start, end] = byStatus(s, [125_000, 145_000] as const, [250_000, 290_000] as const, [125_000, 145_000] as const);
  const cap = wages <= start ? 8_500 : wages >= end ? 0 : 8_500 * ((end - wages) / (end - start));
  return Math.min(pos(fed), cap);
}

export const STATE_SPECS: Record<string, StateWithholdingSpec> = {
  AL: {
    state: 'AL', name: 'Alabama', taxYear: 2025, confidence: 'medium', form: 'A-4', verified: false,
    source: 'Alabama DOR, Withholding Tax Tables and Instructions (2025); Ala. Code §40-18-5, §40-18-15',
    notes: 'Subtracts federal income tax withheld; sliding standard deduction; dependent exemption by income.',
    annualTax: ({ annualWages: w, filingStatus: s, dependents, annualFederalWithholding: fed }) => {
      const personal = byStatus(s, 1_500, 3_000, 3_000);
      const perDependent = w <= 20_000 ? 1_000 : w <= 100_000 ? 500 : 300;
      const taxable = w - pos(fed) - alStdDeduction(w, s) - personal - dependents * perDependent;
      const tiers: Tier[] = s === 'MARRIED' ? [[1_000, 0.02], [6_000, 0.04], [I, 0.05]] : [[500, 0.02], [3_000, 0.04], [I, 0.05]];
      return progressive(taxable, tiers);
    },
  },
  AR: {
    state: 'AR', name: 'Arkansas', taxYear: 2025, confidence: 'low', form: 'AR4EC', verified: false,
    source: 'Arkansas DFA, Withholding Tax Formula (effective 1/1/2025)',
    notes: 'Standard deduction $2,410; $29 personal tax credit per exemption. The state formula also has a low-income table this model does not reproduce.',
    annualTax: ({ annualWages: w, allowances }) => {
      const taxable = w - 2_410;
      const tax = progressive(taxable, [[5_499, 0], [10_899, 0.02], [15_599, 0.03], [25_699, 0.034], [I, 0.039]]);
      return pos(tax - 29 * allowances);
    },
  },
  CT: {
    state: 'CT', name: 'Connecticut', taxYear: 2025, confidence: 'low', form: 'CT-W4', verified: false,
    source: 'CT DRS Circular CT (IP 2025(1)), Employer’s Tax Guide — withholding calculation rules',
    notes: 'Personal exemption with phase-out; the personal tax credit (Table C) and the 2% bracket recapture are not modelled, which slightly over-withholds.',
    annualTax: ({ annualWages: w, filingStatus: s }) => {
      const taxable = w - ctExemption(w, s);
      const single: Tier[] = [[10_000, 0.02], [50_000, 0.045], [100_000, 0.055], [200_000, 0.06], [250_000, 0.065], [500_000, 0.069], [I, 0.0699]];
      const hoh: Tier[] = [[16_000, 0.02], [80_000, 0.045], [160_000, 0.055], [320_000, 0.06], [400_000, 0.065], [800_000, 0.069], [I, 0.0699]];
      return progressive(taxable, byStatus(s, single, doubled(single), hoh));
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
  HI: {
    state: 'HI', name: 'Hawaii', taxYear: 2025, confidence: 'low', form: 'HW-4', verified: false,
    source: 'Hawaii DOTAX Booklet A, Employer’s Tax Guide (2025) — Act 46, SLH 2024 brackets',
    notes: '$1,144 per allowance. Act 46 widened the brackets from 2025; check against Booklet A before acknowledging.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - allowances * 1_144;
      const single: Tier[] = [[9_600, 0.014], [14_400, 0.032], [19_200, 0.055], [24_000, 0.064], [36_000, 0.068], [48_000, 0.072], [125_000, 0.076], [175_000, 0.079], [225_000, 0.0825], [275_000, 0.09], [325_000, 0.1], [I, 0.11]];
      return progressive(taxable, s === 'MARRIED' ? doubled(single) : single);
    },
  },
  IA: {
    state: 'IA', name: 'Iowa', taxYear: 2026, confidence: 'low', form: 'IA W-4', verified: false,
    source: 'Iowa DOR, Withholding Formula (2025, flat 3.8% under SF 2442 for 2025 and later)',
    notes: 'Flat 3.8%, less $40 per allowance.',
    annualTax: ({ annualWages: w, allowances }) => pos(w * 0.038 - 40 * allowances),
  },
  KS: {
    state: 'KS', name: 'Kansas', taxYear: 2025, confidence: 'low', form: 'K-4', verified: false,
    source: 'Kansas DOR, Withholding Tax Guide KW-100 (2025) — SB 1 (2024) rates',
    notes: 'Two brackets (5.2% / 5.58%); standard deduction by status; $2,320 per K-4 allowance.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - byStatus(s, 3_605, 8_240, 6_580) - allowances * 2_320;
      const cut = s === 'MARRIED' ? 46_000 : 23_000;
      return progressive(taxable, [[cut, 0.052], [I, 0.0558]]);
    },
  },
  LA: {
    state: 'LA', name: 'Louisiana', taxYear: 2025, confidence: 'low', form: 'L-4', verified: false,
    source: 'Louisiana LDR, Withholding Tables and Instructions (2025) — Act 11, 2024 3rd Ex. Sess. (flat 3%)',
    notes: 'Flat 3% after the standard deduction ($12,500 single, $25,000 married).',
    annualTax: ({ annualWages: w, filingStatus: s }) => pos(w - byStatus(s, 12_500, 25_000, 12_500)) * 0.03,
  },
  ME: {
    state: 'ME', name: 'Maine', taxYear: 2025, confidence: 'medium', form: 'W-4ME', verified: false,
    source: 'Maine Revenue Services, Withholding Tables for Individual Income Tax (2025)',
    notes: 'Standard deduction follows the federal amount; $5,150 per allowance.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - FED_STD_2025(s) - allowances * 5_150;
      const single: Tier[] = [[26_800, 0.058], [63_450, 0.0675], [I, 0.0715]];
      const hoh: Tier[] = [[40_200, 0.058], [95_150, 0.0675], [I, 0.0715]];
      return progressive(taxable, byStatus(s, single, doubled(single), hoh));
    },
  },
  MD: {
    state: 'MD', name: 'Maryland', taxYear: 2025, confidence: 'low', form: 'MW507', verified: false,
    source: 'Comptroller of Maryland, Withholding Tax Facts and Employer Withholding Guide (2025); Budget Reconciliation and Financing Act of 2025',
    notes: 'State brackets plus the county income tax by the MW507 county ($3,200 per exemption). Without a county the most common rate, 3.20%, is used.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances, county }) => {
      const taxable = w - byStatus(s, 3_350, 6_700, 6_700) - allowances * 3_200;
      const single: Tier[] = [[1_000, 0.02], [2_000, 0.03], [3_000, 0.04], [100_000, 0.0475], [125_000, 0.05], [150_000, 0.0525], [250_000, 0.055], [500_000, 0.0575], [1_000_000, 0.0625], [I, 0.065]];
      const joint: Tier[] = [[1_000, 0.02], [2_000, 0.03], [3_000, 0.04], [150_000, 0.0475], [175_000, 0.05], [225_000, 0.0525], [300_000, 0.055], [600_000, 0.0575], [1_200_000, 0.0625], [I, 0.065]];
      const state = progressive(taxable, s === 'SINGLE' ? single : joint);
      return state + pos(taxable) * mdCountyRate(county).rate;
    },
  },
  MO: {
    state: 'MO', name: 'Missouri', taxYear: 2025, confidence: 'medium', form: 'MO W-4', verified: false,
    source: 'Missouri DOR, Employer’s Tax Guide 4282 (2025)',
    notes: 'Standard deduction follows the federal amount; top rate 4.7%.',
    annualTax: ({ annualWages: w, filingStatus: s }) =>
      progressive(w - FED_STD_2025(s), [[1_313, 0], [2_626, 0.02], [3_939, 0.025], [5_252, 0.03], [6_565, 0.035], [7_878, 0.04], [9_191, 0.045], [I, 0.047]]),
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
  NE: {
    state: 'NE', name: 'Nebraska', taxYear: 2026, confidence: 'low', form: 'W-4N', verified: false,
    source: 'Nebraska DOR, Circular EN; LB 754 (2023) rate schedule (4.55% top rate for 2026)',
    notes: '$2,190 per allowance. Nebraska publishes its own withholding tables — check them before acknowledging.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - allowances * 2_190;
      const single: Tier[] = [[4_130, 0.0246], [24_760, 0.0351], [I, 0.0455]];
      return progressive(taxable, s === 'MARRIED' ? doubled(single) : single);
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
  ND: {
    state: 'ND', name: 'North Dakota', taxYear: 2025, confidence: 'low', form: null, verified: false,
    source: 'ND Office of State Tax Commissioner, Income Tax Withholding Rates and Instructions (2025)',
    notes: 'Uses the federal W-4; 0% / 1.95% / 2.5% after the standard deduction.',
    annualTax: ({ annualWages: w, filingStatus: s }) => {
      const [a, b] = byStatus(s, [48_475, 244_825] as const, [80_975, 298_075] as const, [64_950, 271_450] as const);
      return progressive(w - FED_STD_2025(s), [[a, 0], [b, 0.0195], [I, 0.025]]);
    },
  },
  OK: {
    state: 'OK', name: 'Oklahoma', taxYear: 2025, confidence: 'medium', form: 'OK-W-4', verified: false,
    source: 'Oklahoma Tax Commission, Packet OW-2 withholding tables (2025)',
    notes: 'Standard deduction by status, $1,000 per allowance; brackets 0.25%–4.75%. HB 2764 lowers the 2026 top rate to 4.5% — update when OW-2 for 2026 is published.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - byStatus(s, 6_350, 12_700, 9_350) - allowances * 1_000;
      const single: Tier[] = [[1_000, 0.0025], [2_500, 0.0075], [3_750, 0.0175], [4_900, 0.0275], [7_200, 0.0375], [I, 0.0475]];
      return progressive(taxable, s === 'MARRIED' ? doubled(single) : single);
    },
  },
  OR: {
    state: 'OR', name: 'Oregon', taxYear: 2025, confidence: 'medium', form: 'OR-W-4', verified: false,
    source: 'Oregon DOR, Withholding Tax Formula 150-206-436 (2025); statewide transit tax ORS 320.550',
    notes: 'Subtracts federal tax (capped at $8,500, phased out at higher incomes); $256 credit per allowance; plus the 0.1% statewide transit tax.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances, annualFederalWithholding: fed }) => {
      const taxable = w - orFederalSubtraction(w, fed, s) - byStatus(s, 2_835, 5_670, 4_560);
      const single: Tier[] = [[4_400, 0.0475], [11_050, 0.0675], [125_000, 0.0875], [I, 0.099]];
      const married: Tier[] = [[8_800, 0.0475], [22_100, 0.0675], [250_000, 0.0875], [I, 0.099]];
      const tax = progressive(taxable, s === 'MARRIED' ? married : single);
      const creditLimit = s === 'MARRIED' ? 200_000 : 100_000;
      const credit = w > creditLimit ? 0 : 256 * allowances;
      const transit = w * 0.001;
      return pos(tax - credit) + transit;
    },
  },
  RI: {
    state: 'RI', name: 'Rhode Island', taxYear: 2025, confidence: 'low', form: 'RI W-4', verified: false,
    source: 'RI Division of Taxation, Withholding Tables (2025)',
    notes: '$5,100 per exemption; brackets 3.75% / 4.75% / 5.99%.',
    annualTax: ({ annualWages: w, allowances }) =>
      progressive(w - allowances * 5_100, [[79_900, 0.0375], [181_650, 0.0475], [I, 0.0599]]),
  },
  SC: {
    state: 'SC', name: 'South Carolina', taxYear: 2025, confidence: 'low', form: 'SC W-4', verified: false,
    source: 'SC DOR, Withholding Tax Formula (2025)',
    notes: 'Standard deduction (10% of wages up to $7,500) when exemptions are claimed, $4,830 per exemption; 0% / 3% / 6.2%.',
    annualTax: ({ annualWages: w, allowances }) => {
      const std = allowances > 0 ? Math.min(0.1 * w, 7_500) : 0;
      return progressive(w - std - allowances * 4_830, [[3_560, 0], [17_830, 0.03], [I, 0.062]]);
    },
  },
  VT: {
    state: 'VT', name: 'Vermont', taxYear: 2025, confidence: 'low', form: 'W-4VT', verified: false,
    source: 'Vermont Department of Taxes, Income Tax Withholding Instructions, Tables and Charts (2025)',
    notes: '$5,300 per allowance; brackets 3.35%–8.75%. Vermont’s withholding brackets include an implicit deduction — check against its percentage method.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - allowances * 5_300;
      const single: Tier[] = [[47_900, 0.0335], [116_000, 0.066], [242_000, 0.076], [I, 0.0875]];
      const married: Tier[] = [[79_950, 0.0335], [193_300, 0.066], [294_600, 0.076], [I, 0.0875]];
      return progressive(taxable, s === 'MARRIED' ? married : single);
    },
  },
  WV: {
    state: 'WV', name: 'West Virginia', taxYear: 2025, confidence: 'low', form: 'WV/IT-104', verified: false,
    source: 'WV Tax Division, Employer’s Withholding Tables IT-100.1A (2025) — SB 2033 rate reduction',
    notes: '$2,000 per exemption; brackets 2.22%–4.82%.',
    annualTax: ({ annualWages: w, allowances }) =>
      progressive(w - allowances * 2_000, [[10_000, 0.0222], [25_000, 0.0296], [40_000, 0.0333], [60_000, 0.0444], [I, 0.0482]]),
  },
  WI: {
    state: 'WI', name: 'Wisconsin', taxYear: 2025, confidence: 'low', form: 'WT-4', verified: false,
    source: 'Wisconsin DOR, Publication W-166 Withholding Tax Guide, Method B (2025)',
    notes: 'Sliding standard deduction, $700 per exemption; brackets 3.5%–7.65%.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - wiStdDeduction(w, s) - allowances * 700;
      const single: Tier[] = [[14_680, 0.035], [29_370, 0.044], [323_290, 0.053], [I, 0.0765]];
      const married: Tier[] = [[19_580, 0.035], [39_150, 0.044], [431_060, 0.053], [I, 0.0765]];
      return progressive(taxable, s === 'MARRIED' ? married : single);
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
  spec: StateWithholdingSpec,
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
  });
  const cycle = Math.max(0, annual) / input.periods + Math.max(0, w4?.additionalWithholding ?? 0);
  return Math.round(cycle * 100) / 100;
}
