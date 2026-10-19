/**
 * Deduction tax treatment — federal and state.
 *
 * Every deduction on a paycheck either lowers a wage base or it doesn't, and
 * the answer differs by tax and by state: a 401(k) deferral lowers federal
 * income tax wages but not Social Security, Medicare or FUTA wages; in
 * Pennsylvania it lowers nothing at all; an HSA contribution through the
 * cafeteria plan lowers every federal base but California and New Jersey
 * tax it anyway. This module is the one place those rules live.
 *
 * A wage base is named by a string, the same strings stored on each
 * PayrollItemDeduction.exemptFrom (a snapshot taken when the check is cut):
 *
 *   FIT           federal income tax wages (W-2 Box 1)
 *   SS, MEDICARE  Social Security / Medicare wages (Boxes 3 and 5)
 *   FUTA          federal unemployment wages (Form 940)
 *   SIT:XX        state XX income tax wages (Box 16)
 *   SUI:XX        state XX unemployment insurance wages
 *   PGM:XX_YYY    a state disability / paid-leave program (CA_SDI, NJ_TDI, NJ_FLI, NY_PFL …)
 *   LOCAL         local income tax wages (PA EIT, Ohio municipal, NYC …)
 *
 * Sources (verified 2026-10-18; re-check each January):
 *  - Federal: IRS Pub 15-B (2026) Table 2-1, Pub 15 §5 (401(k)/403(b)/457
 *    elective deferrals are FICA and FUTA wages), Pub 969 (HSA via §125).
 *  - Pennsylvania: PA DOR Personal Income Tax Guide, Compensation; letter
 *    ruling PIT-06-005 (HSA through a cafeteria plan excluded); §125 is
 *    excluded only for hospitalization, sickness, disability or death
 *    (medical, dental, vision, health FSA, life, disability) — dependent
 *    care is taxable; elective deferrals to 401(k)/403(b)/457 are taxable.
 *    Local EIT (Act 32) follows the PA PIT definition of compensation.
 *  - New Jersey: N.J.S.A. 54A:6-21 and NJ Division of Taxation TB-39(R):
 *    only 401(k) deferrals are excluded from NJ wages; 403(b), 457, HSA and
 *    salary-reduction cafeteria contributions are taxable. UI/TDI/FLI:
 *    N.J.A.C. 12:16-4.4 (401(k) and 403(b) taxable) and 12:16-4.15 (§125
 *    salary reductions taxable) — nothing comes off NJ UI/TDI/FLI wages.
 *  - California: EDD DE 231EB (Taxability of Employee Benefits): HSA
 *    contributions (employee and employer) are subject to UI/ETT, SDI and
 *    PIT; 401(k) salary reductions are subject to UI and SDI, not PIT;
 *    §125 health, dependent care and group-term life are not subject.
 *  - HSA conformity: only California and New Jersey tax HSA contributions
 *    (Alabama conformed January 1, 2018).
 *  - Ohio municipal income tax: ORC 718.01 "qualifying wages" are §3121(a)
 *    Medicare wages, with 401(k)/403(b)/457 deferrals added back; §125
 *    stays excluded.
 *  - Every other state with a wage income tax starts from federal wages for
 *    these benefits (ICI state tax survey, "same as federal").
 *
 * What is NOT verified is said so: `UNVERIFIED` below lists each state and
 * scope where the treatment falls back to the federal rule without a source.
 * The state tax review page shows the list so payroll confirms it with the
 * tax adviser (lib/payrollReview gates nothing on it; it is a review item).
 */

export type DeductionCode =
  | 'MEDICAL'
  | 'DENTAL'
  | 'VISION'
  | 'HSA'
  | 'HEALTH_FSA'
  | 'DCAP'
  | 'LIFE'
  | 'DISABILITY'
  | 'RET_401K'
  | 'RET_403B'
  | 'RET_457B'
  | 'ROTH_401K'
  | 'ROTH_403B'
  | 'RET_LOAN'
  | 'GARNISHMENT'
  | 'GARNISHMENT_FEE'
  | 'EWA_RECOVERY'
  | 'RIDES'
  | 'UNION_DUES'
  | 'AFTER_TAX_OTHER'
  | 'ER_401K_MATCH'
  | 'ER_HEALTH'
  | 'ER_HSA'
  | 'ER_TRUMP_ACCOUNT';

export type DeductionCategory = 'PRE_TAX' | 'POST_TAX' | 'EMPLOYER';

/** How a deduction relates to the federal bases. */
type Kind =
  /** §125 accident / health / life / disability: off every federal base. */
  | 'S125'
  /** HSA through the cafeteria plan: off every federal base. */
  | 'S125_HSA'
  /** Dependent care assistance (§129 via §125): off every federal base, W-2 Box 10. */
  | 'S125_DCAP'
  /** Elective deferral: off FIT only. */
  | 'DEFERRAL'
  /** After tax: off nothing. */
  | 'NONE'
  /** Employer-paid: never part of gross, so it lowers nothing. */
  | 'EMPLOYER';

export interface CodeSpec {
  category: DeductionCategory;
  label: string;
  kind: Kind;
  /** W-2 Box 12 code. The Box 12 amount is employeeAmount + employerAmount of every line with the code. */
  box12?: string;
  box10?: boolean;
  box14?: string;
}

export const CODES: Record<DeductionCode, CodeSpec> = {
  MEDICAL: { category: 'PRE_TAX', label: 'Medical', kind: 'S125', box12: 'DD' },
  DENTAL: { category: 'PRE_TAX', label: 'Dental', kind: 'S125' },
  VISION: { category: 'PRE_TAX', label: 'Vision', kind: 'S125' },
  HSA: { category: 'PRE_TAX', label: 'HSA', kind: 'S125_HSA', box12: 'W' },
  HEALTH_FSA: { category: 'PRE_TAX', label: 'Health FSA', kind: 'S125' },
  DCAP: { category: 'PRE_TAX', label: 'Dependent care FSA', kind: 'S125_DCAP', box10: true },
  LIFE: { category: 'PRE_TAX', label: 'Life insurance', kind: 'S125' },
  DISABILITY: { category: 'PRE_TAX', label: 'Disability insurance', kind: 'S125' },
  RET_401K: { category: 'PRE_TAX', label: '401(k)', kind: 'DEFERRAL', box12: 'D' },
  RET_403B: { category: 'PRE_TAX', label: '403(b)', kind: 'DEFERRAL', box12: 'E' },
  RET_457B: { category: 'PRE_TAX', label: '457(b)', kind: 'DEFERRAL', box12: 'G' },
  ROTH_401K: { category: 'POST_TAX', label: 'Roth 401(k)', kind: 'NONE', box12: 'AA' },
  ROTH_403B: { category: 'POST_TAX', label: 'Roth 403(b)', kind: 'NONE', box12: 'BB' },
  RET_LOAN: { category: 'POST_TAX', label: '401(k) loan repayment', kind: 'NONE' },
  GARNISHMENT: { category: 'POST_TAX', label: 'Garnishment', kind: 'NONE' },
  GARNISHMENT_FEE: { category: 'POST_TAX', label: 'Garnishment processing fee', kind: 'NONE' },
  EWA_RECOVERY: { category: 'POST_TAX', label: 'Earned-wage advance repaid', kind: 'NONE' },
  RIDES: { category: 'POST_TAX', label: 'Van rides', kind: 'NONE' },
  UNION_DUES: { category: 'POST_TAX', label: 'Union dues', kind: 'NONE', box14: 'UNION DUES' },
  AFTER_TAX_OTHER: { category: 'POST_TAX', label: 'Other deduction', kind: 'NONE' },
  ER_401K_MATCH: { category: 'EMPLOYER', label: '401(k) employer contribution', kind: 'EMPLOYER' },
  ER_HEALTH: { category: 'EMPLOYER', label: 'Employer health coverage', kind: 'EMPLOYER', box12: 'DD' },
  ER_HSA: { category: 'EMPLOYER', label: 'Employer HSA contribution', kind: 'EMPLOYER', box12: 'W' },
  ER_TRUMP_ACCOUNT: { category: 'EMPLOYER', label: 'Employer Trump account contribution', kind: 'EMPLOYER', box12: 'TA' },
};

/** States with no tax on wage income (no SIT base). New Hampshire taxes only interest and dividends (repealed 2025). */
export const NO_WAGE_INCOME_TAX = new Set(['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']);

export const ALL_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

/** The state disability / paid-leave programs whose wage base this module knows. Codes match the tax engine's STATE_PROGRAM lines. */
export const PROGRAM_STATES: Record<string, string[]> = {
  CA: ['CA_SDI'],
  NJ: ['NJ_TDI', 'NJ_FLI'],
  NY: ['NY_DBL', 'NY_PFL'],
  WA: ['WA_PFML', 'WA_CARES'],
  MA: ['MA_PFML'],
  OR: ['OR_PFML'],
  CO: ['CO_FAMLI'],
  CT: ['CT_PFML'],
  RI: ['RI_TDI'],
  HI: ['HI_TDI'],
  DE: ['DE_PFML'],
  MN: ['MN_PFML'],
  MD: ['MD_FAMLI'],
  ME: ['ME_PFML'],
};

/** Where the treatment is the federal fallback without a source behind it. Shown on the state tax review page. */
export const UNVERIFIED: Array<{ state: string; scope: 'SUI' | 'PROGRAM' | 'LOCAL'; note: string }> = [
  { state: 'PA', scope: 'SUI', note: 'PA unemployment (employer and employee shares) is assumed to exclude §125 and include 401(k) deferrals, like FUTA. CONFIRM WITH PA L&I UC-2 instructions.' },
  { state: 'AK', scope: 'SUI', note: 'Alaska unemployment (employer and employee shares) is assumed to follow FUTA for §125 and 401(k). CONFIRM WITH Alaska DOL Employer Handbook.' },
  { state: 'HI', scope: 'SUI', note: 'Hawaii unemployment and TDI are assumed to follow FUTA for §125 and 401(k). CONFIRM WITH Hawaii DLIR.' },
  { state: 'NY', scope: 'PROGRAM', note: 'NY DBL and PFL wages are assumed to equal NY unemployment wages (§125 excluded, 401(k) included). CONFIRM WITH NY WCB PFL employer guide.' },
  { state: 'WA', scope: 'PROGRAM', note: 'WA PFML and WA Cares wages are assumed to follow WA unemployment wages. CONFIRM WITH WA ESD PFML employer toolkit.' },
  { state: 'MA', scope: 'PROGRAM', note: 'MA PFML wages are assumed to be Social Security wages (§125 excluded, 401(k) included). CONFIRM WITH MA DFML employer guide.' },
  { state: 'OR', scope: 'PROGRAM', note: 'Paid Leave Oregon wages are assumed to follow Oregon unemployment wages. CONFIRM WITH Paid Leave Oregon.' },
  { state: 'CO', scope: 'PROGRAM', note: 'Colorado FAMLI wages are assumed to follow Colorado unemployment wages. CONFIRM WITH FAMLI Division.' },
  { state: 'CT', scope: 'PROGRAM', note: 'CT Paid Leave wages are assumed to follow CT unemployment wages. CONFIRM WITH CT Paid Leave Authority.' },
  { state: 'RI', scope: 'PROGRAM', note: 'RI TDI wages are assumed to follow RI unemployment wages. CONFIRM WITH RI DLT.' },
  { state: 'HI', scope: 'PROGRAM', note: 'Hawaii TDI wages are assumed to follow Hawaii unemployment wages. CONFIRM WITH Hawaii DLIR.' },
  { state: 'DE', scope: 'PROGRAM', note: 'Delaware Paid Leave wages are assumed to follow Delaware unemployment wages. CONFIRM WITH Delaware DOL.' },
  { state: 'MN', scope: 'PROGRAM', note: 'Minnesota Paid Leave wages are assumed to follow Minnesota unemployment wages. CONFIRM WITH MN DEED.' },
  { state: 'MD', scope: 'PROGRAM', note: 'Maryland FAMLI wages (when contributions start) are assumed to follow Maryland unemployment wages. CONFIRM WITH MD Labor.' },
  { state: 'ME', scope: 'PROGRAM', note: 'Maine PFML wages are assumed to follow Maine unemployment wages. CONFIRM WITH Maine DOL.' },
  { state: 'KY', scope: 'LOCAL', note: 'Kentucky occupational license taxes are assumed to tax 401(k) deferrals and exclude §125, like Ohio. CONFIRM WITH each city/county ordinance.' },
  { state: 'MO', scope: 'LOCAL', note: 'Kansas City and St. Louis earnings taxes are assumed to tax 401(k) deferrals and exclude §125. CONFIRM WITH each city revenue division.' },
];

/* ---- Per-base rules ---------------------------------------------------- */

function federalExempt(kind: Kind): { fit: boolean; ss: boolean; medicare: boolean; futa: boolean } {
  switch (kind) {
    case 'S125':
    case 'S125_HSA':
    case 'S125_DCAP':
      return { fit: true, ss: true, medicare: true, futa: true };
    case 'DEFERRAL':
      return { fit: true, ss: false, medicare: false, futa: false };
    default:
      return { fit: false, ss: false, medicare: false, futa: false };
  }
}

/** Does this deduction come off state XX's income tax wages? */
export function sitExempt(code: DeductionCode, state: string): boolean {
  const spec = CODES[code];
  const fed = federalExempt(spec.kind);
  if (!fed.fit) return false;
  switch (state) {
    case 'PA':
      // Elective deferrals and dependent care are PA compensation; health, life, disability and HSA via §125 are not.
      return spec.kind === 'S125' || spec.kind === 'S125_HSA';
    case 'NJ':
      // Only 401(k) deferrals are excluded (N.J.S.A. 54A:6-21).
      return code === 'RET_401K';
    case 'CA':
      return spec.kind !== 'S125_HSA';
    default:
      return true;
  }
}

/** Does this deduction come off state XX's unemployment wages? */
export function suiExempt(code: DeductionCode, state: string): boolean {
  const spec = CODES[code];
  const fed = federalExempt(spec.kind);
  if (!fed.futa) return false;
  if (state === 'NJ') return false; // N.J.A.C. 12:16-4.15
  if (state === 'CA') return spec.kind !== 'S125_HSA'; // DE 231EB
  return true;
}

/** Does this deduction come off a state program's wages (CA_SDI, NJ_TDI …)? Programs follow their state's UI wages unless known otherwise. */
export function programExempt(code: DeductionCode, program: string): boolean {
  const state = program.slice(0, 2);
  return suiExempt(code, state);
}

/**
 * Local income tax wages. Pennsylvania EIT follows PA compensation; Ohio
 * (and, unverified, Kentucky and Missouri cities) tax Medicare wages with
 * deferrals added back; everyone else follows the federal income tax base.
 */
export function localExempt(code: DeductionCode, localStates: string[]): boolean {
  const spec = CODES[code];
  if (!federalExempt(spec.kind).fit) return false;
  if (localStates.includes('PA')) return sitExempt(code, 'PA');
  if (localStates.some((s) => s === 'OH' || s === 'KY' || s === 'MO')) return spec.kind !== 'DEFERRAL';
  return true;
}

export interface TaxabilityContext {
  /** States the person worked in this period (by time-entry site). */
  workStates: string[];
  residentState: string | null;
  /** Whether any local tax could apply (a PA, OH, KY, MO, NY, MI, IN … work site or residence). */
  localApplies: boolean;
}

function statesOf(ctx: TaxabilityContext): string[] {
  const s = new Set<string>();
  for (const w of ctx.workStates) if (w) s.add(w.toUpperCase());
  if (ctx.residentState) s.add(ctx.residentState.toUpperCase());
  return [...s].sort();
}

/** The wage bases this deduction lowers for this person — the exemptFrom snapshot. */
export function exemptBasesFor(code: DeductionCode, ctx: TaxabilityContext): string[] {
  const spec = CODES[code];
  if (spec.category === 'EMPLOYER') return [];
  const out: string[] = [];
  const fed = federalExempt(spec.kind);
  if (fed.fit) out.push('FIT');
  if (fed.ss) out.push('SS');
  if (fed.medicare) out.push('MEDICARE');
  if (fed.futa) out.push('FUTA');
  const states = statesOf(ctx);
  for (const st of states) {
    if (!NO_WAGE_INCOME_TAX.has(st) && sitExempt(code, st)) out.push(`SIT:${st}`);
    if (suiExempt(code, st)) out.push(`SUI:${st}`);
    for (const p of PROGRAM_STATES[st] ?? []) if (programExempt(code, p)) out.push(`PGM:${p}`);
  }
  if (ctx.localApplies && localExempt(code, states)) out.push('LOCAL');
  return out;
}

export interface DeductionLineInput {
  code: DeductionCode | string;
  category: DeductionCategory | string;
  employeeAmount: number;
  exemptFrom: string[];
}

export interface TaxableWages {
  fit: number;
  ss: number;
  medicare: number;
  futa: number;
  stateIncome: Record<string, number>;
  stateUi: Record<string, number>;
  stateProgram: Record<string, number>;
  local: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Every wage base for a check, from gross and its deduction lines' exemptFrom
 * snapshots. Each state figure is the whole check's taxable wages under that
 * state's rule (the tax engine allocates across work states by hours).
 */
export function taxableWages(gross: number, lines: DeductionLineInput[], ctx: TaxabilityContext): TaxableWages {
  const off = (base: string) => lines.reduce((s, l) => (l.category !== 'EMPLOYER' && l.exemptFrom.includes(base) ? s + l.employeeAmount : s), 0);
  const base = (name: string) => r2(Math.max(0, gross - off(name)));
  const states = statesOf(ctx);
  const stateIncome: Record<string, number> = {};
  const stateUi: Record<string, number> = {};
  const stateProgram: Record<string, number> = {};
  for (const st of states) {
    if (!NO_WAGE_INCOME_TAX.has(st)) stateIncome[st] = base(`SIT:${st}`);
    stateUi[st] = base(`SUI:${st}`);
    for (const p of PROGRAM_STATES[st] ?? []) stateProgram[p] = base(`PGM:${p}`);
  }
  return {
    fit: base('FIT'),
    ss: base('SS'),
    medicare: base('MEDICARE'),
    futa: base('FUTA'),
    stateIncome,
    stateUi,
    stateProgram,
    local: ctx.localApplies ? base('LOCAL') : base('FIT'),
  };
}

/** Benefits plan kind → deduction code. */
export function codeForPlanKind(kind: string, roth = false): DeductionCode {
  switch (kind) {
    case 'HEALTH_MEDICAL':
      return 'MEDICAL';
    case 'DENTAL':
      return 'DENTAL';
    case 'VISION':
      return 'VISION';
    case 'HSA':
      return 'HSA';
    case 'FSA_HEALTHCARE':
      return 'HEALTH_FSA';
    case 'FSA_DEPENDENT_CARE':
      return 'DCAP';
    case 'LIFE_INSURANCE':
      return 'LIFE';
    case 'DISABILITY':
      return 'DISABILITY';
    case 'RETIREMENT_401K':
      return roth ? 'ROTH_401K' : 'RET_401K';
    case 'RETIREMENT_403B':
      return roth ? 'ROTH_403B' : 'RET_403B';
    default:
      return 'AFTER_TAX_OTHER';
  }
}

/** States where some local tax may apply (the engine's local jurisdictions live here). */
export const LOCAL_TAX_STATES = new Set(['PA', 'OH', 'KY', 'MO', 'NY', 'MI', 'IN', 'MD', 'OR', 'DE', 'AL', 'CO', 'NJ', 'WV']);
