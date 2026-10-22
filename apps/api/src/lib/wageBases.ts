import type { Prisma, PrismaClient } from '@prisma/client';
import { readDeferrals } from './retirementDeferrals.js';

/**
 * Wage bases per paycheck — the one place W-2s, the 941/940, every state
 * and local return and the year-end reconciliation get "what was taxable,
 * and for which tax" from.
 *
 * A check cut with itemized deductions (PayrollItemDeduction) carries, on
 * each line, the bases that deduction lowered when the check was computed
 * (`exemptFrom`: FIT, SS, MEDICARE, FUTA, "SIT:XX", "SUI:XX", "PGM:CODE",
 * "LOCAL"). Those snapshots are used as written: a rule changed later never
 * rewrites a paid check. A check cut before itemized lines existed falls
 * back to the two lump columns exactly as the filings always did:
 *   - §125 (preTaxDeductions − preTaxRetirement) lowers every base;
 *   - 401(k)/403(b) (preTaxRetirement) lowers federal income tax only —
 *     and Pennsylvania taxes it, so PA state wages add it back.
 *
 * State and local wages come from the tax engine's lines on the check
 * (PayrollItemTaxLine): the engine already applied each state's rules and
 * allocated wages across work states, so a two-state worker reports both
 * states, and a resident's state line carries all their wages.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface StateBase {
  state: string;
  wages: number;
  withheld: number;
  resident: boolean;
}
export interface ProgramBase {
  code: string;
  state: string | null;
  label: string;
  wages: number;
  employee: number;
  employer: number;
}
export interface LocalBase {
  code: string;
  kind: string;
  label: string;
  state: string | null;
  wages: number;
  withheld: number;
  employer: boolean;
}

export interface ItemBases {
  itemId: string;
  associateId: string;
  runId: string;
  clientId: string | null;
  paidAt: Date;
  gross: number;
  /** Federal income tax wages (W-2 Box 1 contribution). */
  fitWages: number;
  /** Social Security wages before the annual wage base (Box 3 + Box 7). */
  ssWages: number;
  medicareWages: number;
  /** FUTA wages before the $7,000 base. */
  futaWages: number;
  fit: number;
  ssEmployee: number;
  medicareEmployee: number;
  ssEmployer: number;
  medicareEmployer: number;
  futaEmployer: number;
  sutaEmployer: number;
  states: StateBase[];
  /** The state unemployment insurance is reported to, and the UI wages before its base. */
  suiState: string | null;
  suiWages: number;
  programs: ProgramBase[];
  locals: LocalBase[];
  box12: Record<string, number>;
  box10: number;
  box14: Array<{ label: string; amount: number }>;
  /** Deferrals into a retirement plan this check (W-2 Box 13 "Retirement plan"). */
  retirementPlan: boolean;
  tips: number;
  overtime: number;
  tippedOccupationCode: string | null;
  /** The bases came from itemized deduction lines (false = the lump fallback). */
  itemized: boolean;
}

export const ITEM_BASES_SELECT = {
  id: true,
  associateId: true,
  payrollRunId: true,
  grossPay: true,
  preTaxDeductions: true,
  preTaxRetirement: true,
  federalWithholding: true,
  fica: true,
  medicare: true,
  employerFica: true,
  employerMedicare: true,
  employerFuta: true,
  employerSuta: true,
  stateWithholding: true,
  localWithholding: true,
  taxState: true,
  qualifiedTips: true,
  qualifiedOvertime: true,
  tippedOccupationCode: true,
  deferrals: true,
  payrollRun: { select: { disbursedAt: true, clientId: true } },
  deductions: { select: { code: true, category: true, label: true, employeeAmount: true, employerAmount: true, exemptFrom: true, w2Box12Code: true, w2Box14Label: true, w2Box10: true } },
  taxLines: { select: { code: true, kind: true, label: true, resident: true, workState: true, wages: true, amount: true, employer: true } },
  // Group-term life over $50,000 (lib/groupTermLife): W-2 Box 12 C.
  earnings: { where: { kind: 'IMPUTED_INCOME' }, select: { amount: true } },
  associate: { select: { state: true } },
} satisfies Prisma.PayrollItemSelect;

export type ItemBasesRow = Prisma.PayrollItemGetPayload<{ select: typeof ITEM_BASES_SELECT }>;

const RETIREMENT_CODES = new Set(['D', 'E', 'F', 'G', 'H', 'S', 'AA', 'BB', 'EE']);
const LOCAL_KINDS = new Set(['LOCAL', 'SCHOOL', 'OLT', 'TRANSIT']);

/**
 * W-2 Box 14 label for a state disability / paid-leave program line. States
 * that read Box 14 for these name the label they expect (CA "CASDI", NJ
 * "NJSDI"/"NJFLI"/"UI/WF/SWF", NY "NYSDI"/"NYPFL", RI "RI TDI", HI "HI TDI").
 * CONFIRM: each state's current Box 14 label convention before filing.
 */
export function box14ProgramLabel(code: string, state: string | null, fallback: string): string {
  const c = code.toUpperCase();
  const st = (state ?? c.slice(0, 2)).toUpperCase();
  if (st === 'CA' && /SDI/.test(c)) return 'CASDI';
  if (st === 'NJ' && /FLI/.test(c)) return 'NJFLI';
  if (st === 'NJ' && /(TDI|SDI|DI)/.test(c)) return 'NJSDI';
  if (st === 'NJ' && /(UI|WF|SWF)/.test(c)) return 'UI/WF/SWF';
  if (st === 'NY' && /PFL/.test(c)) return 'NYPFL';
  if (st === 'NY' && /(DBL|SDI|DI)/.test(c)) return 'NYSDI';
  if (st === 'WA' && /CARES|LTC/.test(c)) return 'WA CARES';
  if (st === 'WA' && /PFML|PFL/.test(c)) return 'WA PFML';
  if (/FAMLI/.test(c)) return `${st} FAMLI`;
  if (/TDI/.test(c)) return `${st} TDI`;
  if (/PFML|PFL|PL/.test(c)) return `${st} PFML`;
  if (/SDI|DI/.test(c)) return `${st} SDI`;
  return fallback.slice(0, 40);
}

/** Pure: the bases for one paycheck row. */
export function basesOf(row: ItemBasesRow): ItemBases {
  const gross = Number(row.grossPay);
  const preTax = Number(row.preTaxDeductions);
  const retirement = Number(row.preTaxRetirement);
  const lines = row.deductions;
  const itemized = lines.length > 0;
  const box12: Record<string, number> = {};
  const add12 = (code: string, n: number) => {
    if (n) box12[code] = r2((box12[code] ?? 0) + n);
  };
  const box14: Array<{ label: string; amount: number }> = [];
  let box10 = 0;
  let fitWages: number;
  let ssWages: number;
  let futaWages: number;
  let medicareWages: number;
  let exemptSit: (state: string) => number;
  let exemptSui: (state: string) => number;
  let retirementPlan = false;

  if (itemized) {
    const pre = lines.filter((l) => l.category === 'PRE_TAX');
    const reduced = (tag: string) => pre.filter((l) => l.exemptFrom.includes(tag)).reduce((s, l) => s + Number(l.employeeAmount), 0);
    fitWages = gross - reduced('FIT');
    ssWages = gross - reduced('SS');
    medicareWages = gross - reduced('MEDICARE');
    futaWages = gross - reduced('FUTA');
    const hasStateTags = lines.some((l) => l.exemptFrom.some((t) => t.startsWith('SIT:')));
    const hasSuiTags = lines.some((l) => l.exemptFrom.some((t) => t.startsWith('SUI:')));
    // A state with no SIT:XX tag on a line taxes that deduction; with no state tags at all, the state follows federal.
    exemptSit = (st) => (hasStateTags ? reduced(`SIT:${st}`) : reduced('FIT'));
    exemptSui = (st) => (hasSuiTags ? reduced(`SUI:${st}`) : reduced('FUTA'));
    for (const l of lines) {
      const amount = Number(l.employeeAmount) + Number(l.employerAmount);
      if (l.w2Box12Code) {
        add12(l.w2Box12Code.toUpperCase(), amount);
        if (RETIREMENT_CODES.has(l.w2Box12Code.toUpperCase()) && amount > 0) retirementPlan = true;
      }
      if (l.w2Box10) box10 += amount;
      if (l.w2Box14Label && Number(l.employeeAmount)) box14.push({ label: l.w2Box14Label, amount: Number(l.employeeAmount) });
      if (/^ER_(401K|403B|457|RET)/.test(l.code) && Number(l.employerAmount) > 0) retirementPlan = true;
    }
  } else {
    const section125 = preTax - retirement;
    fitWages = gross - preTax;
    ssWages = gross - section125;
    medicareWages = gross - section125;
    futaWages = gross - section125;
    exemptSit = (st) => (st === 'PA' ? section125 : preTax);
    exemptSui = () => section125;
    const d = readDeferrals(row.deferrals, retirement);
    box10 = d.dcap;
    add12('D', d.pre401k);
    add12('E', d.pre403b);
    add12('W', d.hsa);
    add12('AA', d.roth401k);
    add12('BB', d.roth403b);
    add12('TA', d.trumpAccountEmployer);
    retirementPlan = d.pre401k + d.pre403b + d.roth401k + d.roth403b > 0;
  }
  const tips = Number(row.qualifiedTips);
  // Taxable cost of group-term life over $50,000 — already inside gross; Box 12 C reports it.
  add12('C', ((row as { earnings?: Array<{ amount: Prisma.Decimal | number }> }).earnings ?? []).reduce((sum, e) => sum + Number(e.amount), 0));
  add12('TP', tips);
  add12('TT', Number(row.qualifiedOvertime));

  // State income tax: the engine's lines when it ran, else the check's one state.
  const stateLines = row.taxLines.filter((t) => t.kind === 'STATE' && !t.employer);
  const states: StateBase[] = [];
  if (stateLines.length > 0) {
    for (const t of stateLines) {
      const st = (t.workState ?? t.code.replace(/^ST-/, '')).toUpperCase().slice(0, 2);
      const existing = states.find((s) => s.state === st);
      if (existing) {
        existing.wages = r2(existing.wages + Number(t.wages));
        existing.withheld = r2(existing.withheld + Number(t.amount));
        existing.resident ||= t.resident;
      } else states.push({ state: st, wages: r2(Number(t.wages)), withheld: r2(Number(t.amount)), resident: t.resident });
    }
  } else if (row.taxState) {
    const st = row.taxState.toUpperCase();
    states.push({ state: st, wages: r2(gross - exemptSit(st)), withheld: r2(Number(row.stateWithholding)), resident: (row.associate.state ?? '').toUpperCase() === st });
  }

  const suiLine = row.taxLines.find((t) => t.kind === 'SUI');
  const suiState = (suiLine?.workState ?? row.taxState ?? null)?.toUpperCase() ?? null;
  const suiWages = suiState ? r2(gross - exemptSui(suiState)) : 0;

  const programs: ProgramBase[] = row.taxLines
    .filter((t) => t.kind === 'STATE_PROGRAM')
    .map((t) => ({
      code: t.code,
      state: t.workState ? t.workState.toUpperCase() : null,
      label: t.label,
      wages: Number(t.wages),
      employee: t.employer ? 0 : Number(t.amount),
      employer: t.employer ? Number(t.amount) : 0,
    }));
  // The same program code can arrive as an employee and an employer line: merge them.
  const merged = new Map<string, ProgramBase>();
  for (const p of programs) {
    const m = merged.get(p.code);
    if (m) {
      m.employee = r2(m.employee + p.employee);
      m.employer = r2(m.employer + p.employer);
      m.wages = Math.max(m.wages, p.wages);
    } else merged.set(p.code, { ...p });
  }
  for (const p of merged.values()) if (p.employee) box14.push({ label: box14ProgramLabel(p.code, p.state, p.label), amount: r2(p.employee) });

  const locals: LocalBase[] = row.taxLines
    .filter((t) => LOCAL_KINDS.has(t.kind) || (t.kind === 'EMPLOYER' && t.code !== 'TAX_ENGINE'))
    .map((t) => ({ code: t.code, kind: t.kind, label: t.label, state: t.workState ? t.workState.toUpperCase() : null, wages: Number(t.wages), withheld: Number(t.amount), employer: t.employer }));
  // A pre-engine check with local withholding keeps one unnamed local line.
  if (!locals.length && Number(row.localWithholding) > 0) {
    locals.push({ code: 'LOCAL', kind: 'LOCAL', label: 'Local', state: row.taxState, wages: r2(fitWages), withheld: Number(row.localWithholding), employer: false });
  }

  return {
    itemId: row.id,
    associateId: row.associateId,
    runId: row.payrollRunId,
    clientId: row.payrollRun.clientId,
    paidAt: row.payrollRun.disbursedAt ?? new Date(0),
    gross,
    fitWages: r2(fitWages),
    ssWages: r2(ssWages),
    medicareWages: r2(medicareWages),
    futaWages: r2(futaWages),
    fit: Number(row.federalWithholding),
    ssEmployee: Number(row.fica),
    medicareEmployee: Number(row.medicare),
    ssEmployer: Number(row.employerFica),
    medicareEmployer: Number(row.employerMedicare),
    futaEmployer: Number(row.employerFuta),
    sutaEmployer: Number(row.employerSuta),
    states,
    suiState,
    suiWages,
    programs: [...merged.values()],
    locals,
    box12,
    box10: r2(box10),
    box14,
    retirementPlan,
    tips,
    overtime: Number(row.qualifiedOvertime),
    tippedOccupationCode: row.tippedOccupationCode,
    itemized,
  };
}

/** Bases for every paycheck matching `where` (callers add tenant, period and status filters). */
export async function loadItemBases(db: Db, where: Prisma.PayrollItemWhereInput, take = 200_000): Promise<ItemBases[]> {
  const rows = await db.payrollItem.findMany({ where, select: ITEM_BASES_SELECT, take });
  return rows.map(basesOf);
}
