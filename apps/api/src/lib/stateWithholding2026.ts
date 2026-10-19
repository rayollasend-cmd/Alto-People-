import { progressive, type StateCalcInput, type StateFilingStatus } from './stateWithholding.js';
import { CT_TABLE_C, CT_TABLE_D, CT_TABLE_E } from './ctWithholdingTables.js';

/**
 * 2026 withholding for the states the engine has always treated as
 * covered (STATETAX, October 2026). These replace the 2024 single-filer
 * tax brackets applied to gross pay, which ignored each state's standard
 * deduction, allowances and withholding rates (New Jersey's NJ-WT rates
 * are higher than its tax rates, so the old table under-withheld).
 *
 * Each spec reads the state's own certificate (filing status, allowances,
 * dependents) and cites the agency method it follows. A figure the agency
 * text didn't confirm carries `// CONFIRM WITH <agency>` beside it.
 *
 * These states stay covered without a payroll-admin review: they have
 * always paid people, and gating them now would stop payroll mid-year.
 * Where a figure is unconfirmed, the choice errs toward withholding more.
 *
 * VERIFIED_2026_ADDED (below) adds California, New York, Ohio and
 * Minnesota, and the states that were gated behind a payroll-admin review
 * until their 2026 employer guides were read: AL, CT, HI, IA, KS, MD, MO,
 * ND, NE, OR, RI, VT. Each row cites its document and URL.
 */

export interface VerifiedStateSpec {
  state: string;
  name: string;
  taxYear: number;
  source: string;
  form: string | null;
  notes?: string;
  annualTax(input: StateCalcInput): number;
}

const I = Infinity;
const pos = (n: number) => Math.max(0, n);
const byStatus = <T,>(s: StateFilingStatus, single: T, married: T, hoh: T = single): T => (s === 'MARRIED' ? married : s === 'HEAD_OF_HOUSEHOLD' ? hoh : single);

export const VERIFIED_STATE_SPECS: Record<string, VerifiedStateSpec> = {
  IL: {
    state: 'IL', name: 'Illinois', taxYear: 2026, form: 'IL-W-4',
    source: 'Illinois DOR, Booklet IL-700-T (2026): 4.95%; Line 1 allowance $2,925, Line 2 allowance $1,000',
    notes: 'Allowances are the IL-W-4 Line 1 count; dependents count as Line 2 allowances.',
    annualTax: ({ annualWages: w, allowances, dependents }) => pos(w - allowances * 2_925 - dependents * 1_000) * 0.0495,
  },
  PA: {
    state: 'PA', name: 'Pennsylvania', taxYear: 2026, form: null,
    source: 'PA DOR, Employer Withholding: flat 3.07% of compensation, no allowances (72 P.S. §7302)',
    annualTax: ({ annualWages: w }) => pos(w) * 0.0307,
  },
  MI: {
    state: 'MI', name: 'Michigan', taxYear: 2026, form: 'MI-W4',
    source: 'Michigan Treasury, 2026 withholding: 4.25%, $5,900 per personal and dependent exemption',
    annualTax: ({ annualWages: w, allowances, dependents }) => pos(w - (allowances + dependents) * 5_900) * 0.0425,
  },
  MA: {
    state: 'MA', name: 'Massachusetts', taxYear: 2026, form: 'M-4',
    source: 'Massachusetts DOR, Circular M (effective January 1, 2026): 5%; exemptions $3,400 + $1,000 each; FICA deduction up to $2,000; 4% surtax over $1,107,750',
    notes: 'Head-of-household and blindness add-ons on the M-4 are not modelled (withholds a little more).',
    annualTax: ({ annualWages: w, allowances }) => {
      const exemption = allowances > 0 ? 3_400 + 1_000 * allowances : 0;
      const fica = Math.min(2_000, w * 0.0765);
      const taxable = pos(w - exemption - fica);
      return taxable * 0.05 + pos(taxable - 1_107_750) * 0.04;
    },
  },
  CO: {
    state: 'CO', name: 'Colorado', taxYear: 2026, form: 'DR 0004',
    source: 'Colorado DOR, DR 1098 Withholding Worksheet (2026): 4.40%; annual allowance $5,500, $11,000 married filing jointly, when no DR 0004 claims more',
    annualTax: ({ annualWages: w, filingStatus: s }) => pos(w - byStatus(s, 5_500, 11_000)) * 0.044,
  },
  AZ: {
    state: 'AZ', name: 'Arizona', taxYear: 2026, form: 'A-4',
    source: 'Arizona DOR, Form A-4 (2026): an elected 0.5%–3.5% of gross taxable wages; 2.0% when no A-4 is on file',
    notes: 'The A-4 elected percentage is read from the certificate’s allowances field as tenths of a percent (e.g. 25 = 2.5%); none on file withholds 2.0%.',
    annualTax: ({ annualWages: w, allowances }) => {
      const elected = allowances >= 5 && allowances <= 35 && allowances % 5 === 0 ? allowances / 1000 : 0.02;
      return pos(w) * elected;
    },
  },
  KY: {
    state: 'KY', name: 'Kentucky', taxYear: 2026, form: 'K-4',
    source: 'Kentucky DOR, 2026 Withholding Formula: 3.5% after a $3,360 standard deduction',
    annualTax: ({ annualWages: w }) => pos(w - 3_360) * 0.035,
  },
  IN: {
    state: 'IN', name: 'Indiana', taxYear: 2026, form: 'WH-4',
    source: 'Indiana DOR, Departmental Notice No. 1 (2026): 2.95% state rate, $1,000 per exemption (county tax by the engine)',
    notes: 'The WH-4 additional $1,500 dependent-child exemption is not modelled (withholds a little more).',
    annualTax: ({ annualWages: w, allowances, dependents }) => pos(w - (allowances + dependents) * 1_000) * 0.0295,
  },
  NC: {
    state: 'NC', name: 'North Carolina', taxYear: 2026, form: 'NC-4',
    source: 'NC DOR, NC-30 Income Tax Withholding Tables and Instructions for Employers (2026), Annualized Method: standard deduction $12,750 (single, married or surviving spouse) / $19,125 (head of household); $2,500 per allowance; withholding rate 4.09% (3.99% + 0.1%); https://www.ncdor.gov/income-tax-withholding-tables-and-instructions-employers/open',
    notes: 'Withheld at 4.09%, the 3.99% tax rate plus the NC-30’s 0.1-point withholding margin.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => pos(w - byStatus(s, 12_750, 12_750, 19_125) - allowances * 2_500) * 0.0409,
  },
  UT: {
    state: 'UT', name: 'Utah', taxYear: 2026, form: null,
    source: 'Utah State Tax Commission, Publication 14 Withholding Tax Guide (effective June 1, 2026): 4.45%; base allowance $485 single / $970 married, reduced by 1.3% of wages above $9,348 / $18,696; https://files.tax.utah.gov/tax/forms/pubs/pub-14.pdf',
    annualTax: ({ annualWages: w, filingStatus: s }) => {
      const base = byStatus(s, 485, 970, 485);
      const line = byStatus(s, 9_348, 18_696, 9_348);
      const allowance = pos(base - pos(w - line) * 0.013);
      return pos(w * 0.0445 - allowance);
    },
  },
  ID: {
    state: 'ID', name: 'Idaho', taxYear: 2026, form: 'ID W-4',
    source: 'Idaho State Tax Commission, Income Tax Withholding Tables (2026): 5.3% on annual wages over $16,100 (single, HOH) / $32,200 (married)',
    annualTax: ({ annualWages: w, filingStatus: s }) => pos(w - byStatus(s, 16_100, 32_200, 16_100)) * 0.053,
  },
  GA: {
    state: 'GA', name: 'Georgia', taxYear: 2026, form: 'G-4',
    source: 'Georgia DOR, Employer’s Tax Guide (revised June 2026; HB 463, HB 1199): 4.99% (from May 11, 2026); standard deduction $15,000 / $30,000 MFJ; $5,000 per dependent',
    annualTax: ({ annualWages: w, filingStatus: s, dependents }) => pos(w - byStatus(s, 15_000, 30_000, 15_000) - dependents * 5_000) * 0.0499,
  },
  VA: {
    state: 'VA', name: 'Virginia', taxYear: 2026, form: 'VA-4',
    source: 'Virginia Tax, Employer Withholding Instructions (2026): standard deduction $8,750; $930 per exemption; 2% / 3% / 5% / 5.75%',
    annualTax: ({ annualWages: w, allowances, dependents }) => progressive(w - 8_750 - (allowances + dependents) * 930, [[3_000, 0.02], [5_000, 0.03], [17_000, 0.05], [I, 0.0575]]),
  },
  NJ: {
    state: 'NJ', name: 'New Jersey', taxYear: 2026, form: 'NJ-W4',
    source: 'NJ Division of Taxation, NJ-WT (September 2025) and the New Jersey Withholding Rate Tables: Rate A (single, married separate), Rate B (married joint, head of household); $1,000 per exemption',
    notes: 'Withholding rates, not the tax rates: they run higher, by design.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const taxable = w - allowances * 1_000;
      // Rate A rows to $40,000 confirmed against the 2026 tables; above, CONFIRM WITH NJ Division of Taxation.
      const rateA: Array<[number, number]> = [[20_000, 0.015], [35_000, 0.02], [40_000, 0.039], [75_000, 0.061], [500_000, 0.07], [1_000_000, 0.099], [I, 0.118]];
      // CONFIRM WITH NJ Division of Taxation: Rate B rows.
      const rateB: Array<[number, number]> = [[20_000, 0.015], [40_000, 0.02], [50_000, 0.027], [60_000, 0.039], [150_000, 0.061], [500_000, 0.07], [1_000_000, 0.099], [I, 0.118]];
      return progressive(taxable, s === 'SINGLE' ? rateA : rateB);
    },
  },
};


/* ---- Bracket helper: [over, flat, rate] rows, the agency's own "plus % of excess over" form. ---- */
type Row = [over: number, flat: number, rate: number];
function fromTable(x: number, rows: Row[]): number {
  if (x <= 0) return 0;
  let r = rows[0]!;
  for (const row of rows) if (x > row[0]) r = row;
  return r[1] + (x - r[0]) * r[2];
}
const stepValue = (x: number, rows: Array<[number, number]>, fallback = 0): number => {
  for (const [upTo, v] of rows) if (x <= upTo) return v;
  return fallback;
};

/* California — DE 44 (Rev. 52, 4-26), Method B tables 1, 3, 4 and 5–7 (annual). */
const CA_SINGLE: Row[] = [[0, 0, 0.011], [11_079, 121.87, 0.022], [26_264, 455.94, 0.044], [41_452, 1_124.21, 0.066], [57_542, 2_186.15, 0.088], [72_724, 3_522.17, 0.1023], [371_479, 34_084.81, 0.1133], [445_771, 42_502.09, 0.1243], [742_953, 79_441.81, 0.1353], [1_000_000, 114_220.27, 0.1463]];
const CA_MARRIED: Row[] = [[0, 0, 0.011], [22_158, 243.74, 0.022], [52_528, 911.88, 0.044], [82_904, 2_248.42, 0.066], [115_084, 4_372.3, 0.088], [145_448, 7_044.33, 0.1023], [742_958, 68_169.6, 0.1133], [891_542, 85_004.17, 0.1243], [1_000_000, 98_485.5, 0.1353], [1_485_906, 164_228.58, 0.1463]];
const CA_HOH: Row[] = [[0, 0, 0.011], [22_173, 243.9, 0.022], [52_530, 911.75, 0.044], [67_716, 1_579.93, 0.066], [83_805, 2_641.8, 0.088], [98_990, 3_978.08, 0.1023], [505_208, 45_534.18, 0.1133], [606_251, 56_982.35, 0.1243], [1_000_000, 105_925.35, 0.1353], [1_010_417, 107_334.77, 0.1463]];

/* New York State — NYS-50-T-NYS (1/26), Table A and the annual tax rate schedules (Method II), Method III over $1,077,550 / $2,155,350. */
const NY_SINGLE: Row[] = [[0, 0, 0.039], [8_500, 332, 0.044], [11_700, 472, 0.0515], [13_900, 586, 0.054], [80_650, 4_190, 0.059], [96_800, 5_143, 0.0703], [107_650, 5_906, 0.0753], [157_650, 9_673, 0.064], [215_400, 13_369, 0.1144], [265_400, 19_091, 0.0735]];
const NY_MARRIED: Row[] = [[0, 0, 0.039], [8_500, 332, 0.044], [11_700, 472, 0.0515], [13_900, 586, 0.054], [80_650, 4_190, 0.059], [96_800, 5_143, 0.0657], [107_650, 5_855, 0.0707], [157_650, 9_388, 0.0801], [211_550, 13_708, 0.064], [323_200, 20_854, 0.1349], [373_200, 27_600, 0.0735], [1_077_550, 79_369, 0.0765]];
function nyMethodIII(net: number, married: boolean): number | null {
  const start = married ? 2_155_350 : 1_077_550;
  if (net < start) return null;
  const rate = net < 5_000_000 ? 0.1045 : net < 25_000_000 ? 0.111 : 0.117;
  return net * rate;
}

/* Minnesota — 2026 Minnesota Withholding Tax Instruction Booklet, Computer Formula ($5,300 per allowance). */
const MN_SINGLE: Row[] = [[0, 0, 0], [4_700, 0, 0.0535], [38_010, 1_782.09, 0.068], [114_130, 6_958.25, 0.0785], [207_850, 14_315.27, 0.0985]];
const MN_MARRIED: Row[] = [[0, 0, 0], [14_700, 0, 0.0535], [63_400, 2_605.45, 0.068], [208_180, 12_450.49, 0.0785], [352_630, 23_789.82, 0.0985]];

/* Connecticut — TPG-211, 2026 Withholding Calculation Rules (Rev. 12/25). */
type CtCode = 'A' | 'B' | 'C' | 'D' | 'F';
function ctCode(input: StateCalcInput): CtCode {
  const raw = (input.rawStatus ?? '').trim().toUpperCase();
  if (raw === 'A' || raw === 'B' || raw === 'C' || raw === 'D' || raw === 'F') return raw;
  if (!input.hasCertificate) return 'D'; // no CT-W4: withhold at Code D, the highest
  return input.filingStatus === 'MARRIED' ? 'A' : input.filingStatus === 'HEAD_OF_HOUSEHOLD' ? 'B' : 'F';
}
function ctAnnual(sal: number, code: CtCode): number {
  const ex = { A: [12_000, 24_000], B: [19_000, 38_000], C: [24_000, 48_000], F: [15_000, 30_000], D: [0, 0] }[code];
  const exemption = code === 'D' || sal <= 0 ? 0 : sal <= ex[1]! ? ex[0]! : Math.max(0, ex[0]! - 1_000 * Math.ceil((sal - ex[1]!) / 1_000));
  const taxable = sal - exemption;
  if (taxable <= 0) return 0;
  const k = code === 'B' ? 1.6 : code === 'C' ? 2 : 1;
  const initial = fromTable(taxable, [[0, 0, 0.02], [10_000 * k, 200 * k, 0.045], [50_000 * k, 2_000 * k, 0.055], [100_000 * k, 4_750 * k, 0.06], [200_000 * k, 10_750 * k, 0.065], [250_000 * k, 14_000 * k, 0.069], [500_000 * k, 31_250 * k, 0.0699]]);
  const addBack = stepValue(sal, CT_TABLE_C[code === 'D' ? 'A' : code], 0);
  const recapture = stepValue(sal, CT_TABLE_D[code === 'B' ? 'B' : code === 'C' ? 'C' : 'A'], 0);
  let credit = 0;
  if (code !== 'D') {
    const e = CT_TABLE_E[code];
    credit = sal > e.from ? stepValue(sal, e.rows, 0) : 0;
  }
  return (initial + addBack + recapture) * (1 - credit);
}

/* Maryland — Employer Withholding Guide (January 2026): standard deduction $3,400, $3,200 per exemption, state rates flattened to 4.75% to $100,000 / $150,000 plus the county rate. */
export const MD_COUNTY_RATES_2026: Record<string, number> = {
  ALLEGANY: 0.032, 'BALTIMORE COUNTY': 0.032, 'BALTIMORE CITY': 0.032, CALVERT: 0.032, CAROLINE: 0.032, CARROLL: 0.0303, CECIL: 0.0274, CHARLES: 0.0303,
  DORCHESTER: 0.033, GARRETT: 0.0265, HARFORD: 0.0306, HOWARD: 0.032, KENT: 0.033, MONTGOMERY: 0.032, "PRINCE GEORGE'S": 0.032, "QUEEN ANNE'S": 0.032,
  "ST. MARY'S": 0.032, SOMERSET: 0.032, TALBOT: 0.024, WASHINGTON: 0.0295, WICOMICO: 0.032, WORCESTER: 0.0225,
};
function mdLocal(taxable: number, county: string | null | undefined, joint: boolean): number {
  const c = (county ?? '').trim().toUpperCase();
  if (c === 'ANNE ARUNDEL') {
    const t: Row[] = joint ? [[0, 0, 0.027], [75_000, 2_025, 0.0294], [480_000, 13_932, 0.032]] : [[0, 0, 0.027], [50_000, 1_350, 0.0294], [400_000, 11_640, 0.032]];
    return fromTable(taxable, t);
  }
  if (c === 'FREDERICK') {
    const t: Row[] = joint ? [[0, 0, 0.0225], [25_000, 562.5, 0.0275], [100_000, 2_625, 0.0296], [250_000, 7_065, 0.032]] : [[0, 0, 0.0225], [25_000, 562.5, 0.0275], [50_000, 1_250, 0.0296], [150_000, 4_210, 0.032]];
    return fromTable(taxable, t);
  }
  // Unknown county: the guide's "Unknown Maryland" rate, 3.30%.
  return Math.max(0, taxable) * (MD_COUNTY_RATES_2026[c] ?? 0.033);
}

export const VERIFIED_2026_ADDED: Record<string, VerifiedStateSpec> = {
  CA: {
    state: 'CA', name: 'California', taxYear: 2026, form: 'DE 4',
    source: 'California EDD, DE 44 California Withholding Schedules for 2026 (Rev. 52, 4-26), Method B — Exact Calculation Method, Tables 1, 3, 4 and 5–7 (annual); https://www.edd.ca.gov/siteassets/files/pdf_pub_ctr/de44.pdf',
    notes: 'Low-income exemption, standard deduction and the rate table by status; $168.30 credit per regular allowance. Married with 0–1 allowances uses the single exemption and deduction. Estimated-deduction allowances (DE 4 line 1b) are not read.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const bigMarried = s === 'HEAD_OF_HOUSEHOLD' || (s === 'MARRIED' && allowances >= 2);
      if (w <= (bigMarried ? 37_791 : 18_896)) return 0;
      const taxable = w - (bigMarried ? 11_412 : 5_706);
      const tax = fromTable(taxable, s === 'MARRIED' ? CA_MARRIED : s === 'HEAD_OF_HOUSEHOLD' ? CA_HOH : CA_SINGLE);
      return Math.max(0, tax - 168.3 * allowances);
    },
  },
  NY: {
    state: 'NY', name: 'New York', taxYear: 2026, form: 'IT-2104',
    source: 'NYS Department of Taxation and Finance, NYS-50-T-NYS (1/26), effective January 1 – December 31, 2026: Table A, the annual tax rate schedules (Method II) and Method III; https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_nys.pdf',
    notes: 'Deduction $7,400 single / $7,950 married plus $1,000 per exemption; head of household withholds as single. NYC and Yonkers are local lines from their own 2026 publications.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const married = s === 'MARRIED';
      const net = w - (married ? 7_950 : 7_400) - 1_000 * allowances;
      if (net <= 0) return 0;
      return nyMethodIII(net, married) ?? fromTable(net, married ? NY_MARRIED : NY_SINGLE);
    },
  },
  OH: {
    state: 'OH', name: 'Ohio', taxYear: 2026, form: 'IT 4',
    source: 'Ohio Department of Taxation, Employer Withholding Taxes: Optional Computer Formula (effective August 1, 2026, Rev. 07/26): TW = annual wages − $650 × exemptions; 1.6% to $26,050, $416.80 + 2.99% to $100,000, $2,627.91 + 3.40% above; https://dam.assets.ohio.gov/image/upload/tax.ohio.gov/employer_withholding/2026%20Withholding%20Tables/WHT_OptionalComputerFormula_2026.pdf',
    notes: 'The August 1, 2026 formula (HB 96). Wages paid January–July used the tables effective October 1, 2025; this engine applies the current formula to every 2026 check.',
    annualTax: ({ annualWages: w, allowances }) => fromTable(w - 650 * allowances, [[0, 0, 0.016], [26_050, 416.8, 0.0299], [100_000, 2_627.91, 0.034]]),
  },
  MN: {
    state: 'MN', name: 'Minnesota', taxYear: 2026, form: 'W-4MN',
    source: 'Minnesota Department of Revenue, 2026 Minnesota Income Tax Withholding Instruction Booklet, Computer Formula ($5,300 per allowance); https://www.revenue.state.mn.us/sites/default/files/2025-12/wh-inst-26.pdf',
    notes: 'Head of household withholds as single (W-4MN has single and married only).',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => fromTable(w - 5_300 * allowances, s === 'MARRIED' ? MN_MARRIED : MN_SINGLE),
  },
  AL: {
    state: 'AL', name: 'Alabama', taxYear: 2026, form: 'A-4',
    source: 'Alabama Department of Revenue, Withholding Tax Tables and Instructions for Employers (revised January 2026), Formula for Computing Alabama Withholding Tax; https://revenue.alabama.gov/wp-content/uploads/2026/01/whbooklet_0126.pdf',
    notes: 'Subtracts the annual federal income tax withheld; sliding standard deduction; $1,500 / $3,000 personal exemption; dependents $1,000 / $500 / $300 by income.',
    annualTax: ({ annualWages: w, filingStatus: s, dependents, annualFederalWithholding: fed, rawStatus }) => {
      const code = (rawStatus ?? '').trim().toUpperCase();
      const ms = code === 'MS';
      const [max, step, min, start, inc] = ms
        ? [4_250, 88, 2_500, 12_999, 250]
        : s === 'MARRIED' ? [8_500, 175, 5_000, 25_999, 500] : s === 'HEAD_OF_HOUSEHOLD' ? [5_200, 135, 2_500, 25_999, 500] : [3_000, 25, 2_500, 25_999, 500];
      const std = w <= start ? max : Math.max(min, max - step * Math.ceil((w - start) / inc));
      const personal = code === '0' ? 0 : s === 'MARRIED' || s === 'HEAD_OF_HOUSEHOLD' ? 3_000 : 1_500;
      const perDependent = w <= 50_000 ? 1_000 : w <= 100_000 ? 500 : 300;
      const taxable = w - std - Math.max(0, fed) - personal - dependents * perDependent;
      return fromTable(taxable, s === 'MARRIED' && !ms ? [[0, 0, 0.02], [1_000, 20, 0.04], [6_000, 220, 0.05]] : [[0, 0, 0.02], [500, 10, 0.04], [3_000, 110, 0.05]]);
    },
  },
  CT: {
    state: 'CT', name: 'Connecticut', taxYear: 2026, form: 'CT-W4',
    source: 'CT DRS, TPG-211 2026 Withholding Calculation Rules (Rev. 12/25), Tables A–E; https://portal.ct.gov/-/media/drs/forms/2025/wth/tpg-211_1225.pdf',
    notes: 'By CT-W4 code (A, B, C, D, F). Without a CT-W4, Code D (no exemption, no credit). Single → F, head of household → B, married → A when only a filing status is known.',
    annualTax: (i) => ctAnnual(i.annualWages, ctCode(i)),
  },
  HI: {
    state: 'HI', name: 'Hawaii', taxYear: 2026, form: 'HW-4',
    source: 'Hawaii Department of Taxation, Booklet A Employer’s Tax Guide (Rev. 2025, effective December 5, 2025 for wages paid January 1, 2026): Part 1 annualized method, $1,144 per allowance plus the $4,350 extra lump-sum allowance; https://files.hawaii.gov/tax/news/pubs/25BkltA.pdf',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => {
      const x = w - 1_144 * allowances - 4_350;
      const single: Row[] = [[0, 0, 0.014], [9_600, 134, 0.032], [14_400, 288, 0.055], [19_200, 552, 0.064], [24_000, 859, 0.068], [36_000, 1_675, 0.072], [48_000, 2_539, 0.076], [125_000, 8_391, 0.079]];
      const married: Row[] = [[0, 0, 0.014], [19_200, 269, 0.032], [28_800, 576, 0.055], [38_400, 1_104, 0.064], [48_000, 1_718, 0.068], [72_000, 3_350, 0.072], [96_000, 5_078, 0.076], [250_000, 16_782, 0.079]];
      return fromTable(x, s === 'MARRIED' ? married : single);
    },
  },
  IA: {
    state: 'IA', name: 'Iowa', taxYear: 2026, form: 'IA W-4',
    source: 'Iowa Department of Revenue, Iowa Withholding Formula effective January 1, 2026 (released November 2025): deduction $13,000 / $19,500 HOH / $26,000 MFJ spouse without earned income; 3.80%; $40 per allowance; https://revenue.iowa.gov/media/53/download',
    notes: 'Married uses the $13,000 deduction (spouse with earned income), which withholds more; the $26,000 column applies only when the IA W-4 says the spouse has no earned income.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) => Math.max(0, Math.max(0, w - (s === 'HEAD_OF_HOUSEHOLD' ? 19_500 : 13_000)) * 0.038 - 40 * allowances),
  },
  KS: {
    state: 'KS', name: 'Kansas', taxYear: 2026, form: 'K-4',
    source: 'Kansas Department of Revenue, KW-100 Kansas Withholding Tax Guide (for wages paid on or after July 1, 2024; current for 2026): personal allowance $9,160 each, $2,320 per dependent and for head of household; 5.2% / 5.58%; https://www.ksrevenue.gov/pdf/kw100.pdf',
    annualTax: ({ annualWages: w, filingStatus: s, allowances, dependents }) => {
      const x = w - allowances * 9_160 - dependents * 2_320 - (s === 'HEAD_OF_HOUSEHOLD' ? 2_320 : 0);
      return fromTable(x, s === 'MARRIED' ? [[0, 0, 0], [8_240, 0, 0.052], [54_240, 2_392, 0.0558]] : [[0, 0, 0], [3_605, 0, 0.052], [26_605, 1_196, 0.0558]]);
    },
  },
  MD: {
    state: 'MD', name: 'Maryland', taxYear: 2026, form: 'MW507',
    source: 'Comptroller of Maryland, Employer Withholding Guide (January 2026) percentage method and 2026 State and Local Income Tax Withholding Information (county rates); https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/instructions/withholding/2026/withholding-guide.pdf',
    notes: 'Standard deduction $3,400; $3,200 per MW507 exemption; state 4.75% to $100,000 single / $150,000 joint, rising to 6.50%; plus the county rate (Anne Arundel and Frederick by bracket). No county on the MW507 uses 3.30%.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances, county }) => {
      const joint = s !== 'SINGLE';
      const taxable = w - 3_400 - 3_200 * allowances;
      if (taxable <= 0) return 0;
      const state = joint
        ? fromTable(taxable, [[0, 0, 0.0475], [150_000, 7_125, 0.05], [175_000, 8_375, 0.0525], [225_000, 11_000, 0.055], [300_000, 15_125, 0.0575], [600_000, 32_375, 0.0625], [1_200_000, 69_875, 0.065]])
        : fromTable(taxable, [[0, 0, 0.0475], [100_000, 4_750, 0.05], [125_000, 6_000, 0.0525], [150_000, 7_312.5, 0.055], [250_000, 12_812.5, 0.0575], [500_000, 27_187.5, 0.0625], [1_000_000, 58_437.5, 0.065]]);
      return state + mdLocal(taxable, county, joint);
    },
  },
  MO: {
    state: 'MO', name: 'Missouri', taxYear: 2026, form: 'MO W-4',
    source: 'Missouri Department of Revenue, 2026 Missouri Withholding Tax Formula: standard deduction $16,100 / $24,150 HOH ($32,200 when the spouse does not work); brackets of $1,348 to 4.70% over $9,436; https://dor.mo.gov/forms/Withholding%20Formula_2026.pdf',
    notes: 'Married uses $16,100 (spouse works), which withholds more; the $32,200 deduction applies only when the MO W-4 box says the spouse does not work.',
    annualTax: ({ annualWages: w, filingStatus: s }) =>
      fromTable(w - (s === 'HEAD_OF_HOUSEHOLD' ? 24_150 : 16_100), [[0, 0, 0], [1_348, 0, 0.02], [2_696, 27, 0.025], [4_044, 61, 0.03], [5_392, 101, 0.035], [6_740, 148, 0.04], [8_088, 202, 0.045], [9_436, 263, 0.047]]),
  },
  ND: {
    state: 'ND', name: 'North Dakota', taxYear: 2026, form: null,
    source: 'ND Office of State Tax Commissioner, 2026 Income Tax Withholding Rates and Instructions, Annual Percentage Method Tables (Forms W-4 for 2020 and after); https://www.tax.nd.gov/sites/www/files/documents/forms/individual/2026-iit/2026-income-tax-withholding-rates-booklet.pdf',
    annualTax: ({ annualWages: w, filingStatus: s }) =>
      fromTable(w, s === 'MARRIED' ? [[0, 0, 0], [57_500, 0, 0.0195], [168_525, 2_164.99, 0.025]] : s === 'HEAD_OF_HOUSEHOLD' ? [[0, 0, 0], [78_475, 0, 0.0195], [289_675, 4_118.4, 0.025]] : [[0, 0, 0], [57_625, 0, 0.0195], [258_450, 3_916.09, 0.025]]),
  },
  NE: {
    state: 'NE', name: 'Nebraska', taxYear: 2026, form: 'W-4N',
    source: 'Nebraska Department of Revenue, Circular EN (Rev. 11-2025) for wages paid on or after January 1, 2026: $2,440 per allowance, Table 7 annual payroll period; https://revenue.nebraska.gov/sites/default/files/doc/business/Cir_En_2025/2026cir_en_whole.pdf',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) =>
      fromTable(w - 2_440 * allowances, s === 'MARRIED'
        ? [[0, 0, 0], [8_190, 0, 0.0226], [13_010, 108.93, 0.0322], [32_400, 733.29, 0.0421], [50_400, 1_491.09, 0.0435], [62_530, 2_018.75, 0.0448], [82_920, 2_932.22, 0.046]]
        : [[0, 0, 0], [3_430, 0, 0.0226], [6_710, 74.13, 0.0322], [21_810, 560.35, 0.0421], [31_610, 972.93, 0.0435], [40_130, 1_343.55, 0.0448], [75_370, 2_922.3, 0.046]]),
  },
  OR: {
    state: 'OR', name: 'Oregon', taxYear: 2026, form: 'OR-W-4',
    source: 'Oregon Department of Revenue, Oregon Withholding Tax Formulas 150-206-436 (Rev. 12-31-25), effective January 1, 2026; statewide transit tax 0.1% (ORS 320.550); https://www.oregon.gov/dor/forms/FormsPubs/withholding-tax-formulas_206-436_2026.pdf',
    notes: 'Base = wages − federal tax withheld (capped at $8,750, phased out at higher wages) − standard deduction ($2,910 single with fewer than 3 allowances, else $5,820); $263 credit per allowance (none above $100,000 single / $200,000 married); plus the 0.1% statewide transit tax.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances, annualFederalWithholding: fed }) => {
      const singleTable = s !== 'MARRIED' && allowances < 3;
      // Federal-tax subtraction cap: $8,750, stepping down $1,750 per band from $125,000 (single) / $250,000 (married) to $0.
      const phase = (start: number, step: number) => (w < start ? 8_750 : Math.max(0, 8_750 - 1_750 * (Math.floor((w - start) / step) + 1)));
      const cap = s === 'MARRIED' ? phase(250_000, 10_000) : phase(125_000, 5_000);
      const base = w - Math.min(Math.max(0, fed), cap) - (singleTable ? 2_910 : 5_820);
      const allowanceOk = s === 'MARRIED' ? w <= 200_000 : w <= 100_000;
      const credit = 263 * (allowanceOk ? allowances : 0);
      let tax: number;
      if (w < 50_000) {
        tax = singleTable
          ? base <= 4_550 ? 263 + base * 0.0475 : base <= 11_400 ? 479 + (base - 4_550) * 0.0675 : 941 + (base - 11_400) * 0.0875
          : base <= 9_100 ? 263 + base * 0.0475 : base <= 22_800 ? 695 + (base - 9_100) * 0.0675 : 1_620 + (base - 22_800) * 0.0875;
      } else {
        tax = singleTable
          ? base <= 125_000 ? 678 + (base - 11_400) * 0.0875 : 10_618 + (base - 125_000) * 0.099
          : base <= 250_000 ? 1_357 + (base - 22_800) * 0.0875 : 21_237 + (base - 250_000) * 0.099;
      }
      return Math.max(0, tax - credit) + w * 0.001;
    },
  },
  RI: {
    state: 'RI', name: 'Rhode Island', taxYear: 2026, form: 'RI W-4',
    source: 'RI Division of Taxation, 2026 Employer’s Income Tax Withholding Tables (Table 7, annual; all filing statuses): $1,000 per exemption, none above $290,800 of annual wages; https://tax.ri.gov/sites/g/files/xkgbur541/files/2025-12/2026%20Withholding%20Tax%20Booklet.pdf',
    annualTax: ({ annualWages: w, allowances }) => fromTable(w - (w > 290_800 ? 0 : 1_000 * allowances), [[0, 0, 0.0375], [82_050, 3_076.88, 0.0475], [186_450, 8_035.88, 0.0599]]),
  },
  VT: {
    state: 'VT', name: 'Vermont', taxYear: 2026, form: 'W-4VT',
    source: 'Vermont Department of Taxes, GB-1210-2026 Income Tax Withholding Instructions, Tables and Charts (for wages paid in 2026), annual percentage tables: $5,400 per allowance; https://tax.vermont.gov/sites/tax/files/documents/GB-1210-2026.pdf',
    notes: 'Head of household withholds as single.',
    annualTax: ({ annualWages: w, filingStatus: s, allowances }) =>
      fromTable(w - 5_400 * allowances, s === 'MARRIED'
        ? [[0, 0, 0], [11_775, 0, 0.0335], [96_475, 2_837.45, 0.066], [216_525, 10_760.75, 0.076], [323_825, 18_915.55, 0.0875]]
        : [[0, 0, 0], [3_925, 0, 0.0335], [54_675, 1_700.13, 0.066], [126_775, 6_458.73, 0.076], [260_225, 16_600.93, 0.0875]]),
  },
};

Object.assign(VERIFIED_STATE_SPECS, VERIFIED_2026_ADDED);

export const VERIFIED_STATES = Object.keys(VERIFIED_STATE_SPECS).sort();
