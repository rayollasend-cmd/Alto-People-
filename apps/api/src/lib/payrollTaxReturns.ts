import type { Prisma, PrismaClient, TaxAgencyKind } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { tryDecryptString } from './crypto.js';
import { annualDueDate, periodBounds, quarterlyDueDate } from './payrollTaxCalendar.js';
import { NO_INCOME_TAX_STATES, STATE_NAMES, localJurisdictionOf } from './payrollTaxLedger.js';
import { sutaDefaults } from './payrollTax.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Returns, generated from what payroll actually paid.
 *
 *   F941                 quarterly federal: wages, income tax, Social
 *                        Security and Medicare, deposits made, balance
 *   F940                 annual FUTA: payments, wages over $7,000, tax
 *   STATE_WH_QUARTERLY   a state's withholding return for the quarter
 *   STATE_WH_ANNUAL      the year-end reconciliation (what each W-2 says)
 *   SUI_WAGE_REPORT      a state's unemployment wage report: every person,
 *                        their quarter's wages, excess over the wage base,
 *                        taxable wages, weeks and hours worked
 *   LOCAL_QUARTERLY      a local's return (PA EIT/LST, an Ohio city…)
 *   F941X / STATE_AMENDED  an amendment: the original, the corrected
 *                        figures and the difference
 *
 * Every return reads disbursed pay by the run's disbursement date — the
 * same date the liability ledger posts on — so a return and the ledger can
 * be reconciled to the cent. Formats: the figures and rows are exact; the
 * electronic layouts each state prescribes (ICESA/SSA-style fixed-width,
 * state XML) differ by state, so exports are CSV with the column set
 * named "CONFIRM format" until each state's layout is confirmed.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const round2 = (n: number) => Math.round(n * 100) / 100;

export const RETURN_KINDS = ['F941', 'F940', 'STATE_WH_QUARTERLY', 'STATE_WH_ANNUAL', 'SUI_WAGE_REPORT', 'LOCAL_QUARTERLY', 'F941X', 'STATE_AMENDED'] as const;
export type ReturnKind = (typeof RETURN_KINDS)[number];

export const RETURN_LABEL: Record<ReturnKind, string> = {
  F941: 'Form 941 — quarterly federal',
  F940: 'Form 940 — annual federal unemployment',
  STATE_WH_QUARTERLY: 'State withholding return',
  STATE_WH_ANNUAL: 'State annual reconciliation',
  SUI_WAGE_REPORT: 'State unemployment wage report',
  LOCAL_QUARTERLY: 'Local tax return',
  F941X: 'Form 941-X — amended 941',
  STATE_AMENDED: 'Amended state return',
};

/** The agency a return goes to. */
export function agencyKindFor(kind: ReturnKind): TaxAgencyKind {
  switch (kind) {
    case 'F941':
    case 'F941X':
      return 'FEDERAL_WITHHOLDING';
    case 'F940':
      return 'FEDERAL_UNEMPLOYMENT';
    case 'SUI_WAGE_REPORT':
      return 'STATE_UNEMPLOYMENT';
    case 'LOCAL_QUARTERLY':
      return 'LOCAL';
    default:
      return 'STATE_WITHHOLDING';
  }
}

export function returnDueDate(_kind: ReturnKind, periodLabel: string): Date {
  const b = periodBounds(periodLabel);
  return b.annual ? annualDueDate(b.start.getUTCFullYear()) : quarterlyDueDate(periodLabel);
}

interface PaidItem {
  associateId: string;
  firstName: string;
  lastName: string;
  ssn: string | null;
  ssnLast4: string | null;
  grossPay: number;
  preTaxDeductions: number;
  preTaxRetirement: number;
  federalWithholding: number;
  fica: number;
  medicare: number;
  employerFica: number;
  employerMedicare: number;
  employerFuta: number;
  employerSuta: number;
  stateWithholding: number;
  localWithholding: number;
  taxState: string | null;
  localJurisdiction: string | null;
  paidAt: Date;
}

/** Disbursed pay with a disbursement date in [from, toExclusive). */
async function paidItems(db: Db, from: Date, toExclusive: Date, withSsn = false): Promise<PaidItem[]> {
  const rows = await db.payrollItem.findMany({
    where: { tenantId: tenantIdForWrite(), status: 'DISBURSED', payrollRun: { disbursedAt: { gte: from, lt: toExclusive } } },
    select: {
      associateId: true, grossPay: true, preTaxDeductions: true, preTaxRetirement: true, federalWithholding: true, fica: true, medicare: true,
      employerFica: true, employerMedicare: true, employerFuta: true, employerSuta: true, stateWithholding: true, localWithholding: true, taxState: true,
      payrollRun: { select: { disbursedAt: true } },
      associate: {
        select: {
          firstName: true, lastName: true, ssnLast4: true,
          localTaxRule: { select: { state: true, name: true } },
          ...(withSsn ? { w4Submission: { select: { ssnEncrypted: true } } } : {}),
        },
      },
    },
    take: 200_000,
  });
  return rows.map((r) => {
    const a = r.associate as typeof r.associate & { w4Submission?: { ssnEncrypted: Uint8Array | null } | null };
    const enc = a.w4Submission?.ssnEncrypted;
    return {
      associateId: r.associateId,
      firstName: a.firstName,
      lastName: a.lastName,
      ssn: enc ? tryDecryptString(Buffer.from(enc)) : null,
      ssnLast4: a.ssnLast4,
      grossPay: Number(r.grossPay),
      preTaxDeductions: Number(r.preTaxDeductions),
      preTaxRetirement: Number(r.preTaxRetirement),
      federalWithholding: Number(r.federalWithholding),
      fica: Number(r.fica),
      medicare: Number(r.medicare),
      employerFica: Number(r.employerFica),
      employerMedicare: Number(r.employerMedicare),
      employerFuta: Number(r.employerFuta),
      employerSuta: Number(r.employerSuta),
      stateWithholding: Number(r.stateWithholding),
      localWithholding: Number(r.localWithholding),
      taxState: r.taxState ? r.taxState.toUpperCase() : null,
      localJurisdiction: localJurisdictionOf(a.localTaxRule),
      paidAt: r.payrollRun.disbursedAt ?? new Date(0),
    };
  });
}

const sum = (rows: PaidItem[], f: (r: PaidItem) => number) => round2(rows.reduce((a, r) => a + f(r), 0));

/** Payments recorded as paid to an agency for a period (the deposits a return credits). */
async function depositsMade(db: Db, kind: TaxAgencyKind, jurisdiction: string, from: Date, toExclusive: Date): Promise<number> {
  const rows = await db.taxLiability.findMany({
    where: { tenantId: tenantIdForWrite(), kind, jurisdiction, status: 'PAID', liabilityDate: { gte: from, lt: toExclusive } },
    select: { amount: true },
  });
  return round2(rows.reduce((a, r) => a + Number(r.amount), 0));
}

export interface GeneratedReturn {
  kind: ReturnKind;
  jurisdiction: string;
  periodLabel: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  /** The headline figures (what reconciliation compares). */
  totals: Record<string, number>;
  /** The per-person rows where the return has them (wage reports, annual reconciliations, locals). */
  rows: Array<Record<string, string | number | null>>;
  notes: string[];
}

/** Build a return's figures from disbursed pay. */
export async function generateReturn(db: Db, kind: ReturnKind, jurisdiction: string, periodLabel: string): Promise<GeneratedReturn> {
  const b = periodBounds(periodLabel);
  const annualKinds: ReturnKind[] = ['F940', 'STATE_WH_ANNUAL'];
  if (annualKinds.includes(kind) !== b.annual) throw new HttpError(400, 'wrong_period', annualKinds.includes(kind) ? 'This return is annual: give a year like 2026.' : 'This return is quarterly: give a quarter like 2026-Q4.');
  const base = { kind, jurisdiction, periodLabel, periodStart: b.start, periodEnd: b.end, dueDate: returnDueDate(kind, periodLabel) };
  const notes: string[] = [];

  if (kind === 'F941') {
    const items = await paidItems(db, b.start, b.endExclusive);
    const section125 = (r: PaidItem) => r.preTaxDeductions - r.preTaxRetirement;
    const employees = new Set(items.map((i) => i.associateId)).size;
    const wages = sum(items, (r) => r.grossPay - r.preTaxDeductions);
    const fit = sum(items, (r) => r.federalWithholding);
    const ssWages = sum(items, (r) => (r.employerFica > 0 ? r.grossPay - section125(r) : 0));
    const ssTax = sum(items, (r) => r.fica + r.employerFica);
    const medWages = sum(items, (r) => r.grossPay - section125(r));
    const medTaxEmployer = sum(items, (r) => r.employerMedicare);
    const medTaxEmployee = sum(items, (r) => r.medicare);
    const addlMedicare = round2(Math.max(0, medTaxEmployee - medTaxEmployer));
    const line5aCol2 = round2(ssWages * 0.124);
    const line5cCol2 = round2(medWages * 0.029);
    const line5dCol2 = addlMedicare;
    const line6 = round2(fit + line5aCol2 + line5cCol2 + line5dCol2);
    const actualTotal = round2(fit + ssTax + medTaxEmployee + medTaxEmployer);
    const line7 = round2(actualTotal - line6);
    const line12 = round2(line6 + line7);
    const deposits = await depositsMade(db, 'FEDERAL_WITHHOLDING', 'US', b.start, b.endExclusive);
    const monthly = [0, 1, 2].map((m) => {
      const from = new Date(Date.UTC(b.start.getUTCFullYear(), b.start.getUTCMonth() + m, 1));
      const to = new Date(Date.UTC(b.start.getUTCFullYear(), b.start.getUTCMonth() + m + 1, 1));
      return sum(items.filter((i) => i.paidAt >= from && i.paidAt < to), (r) => r.federalWithholding + r.fica + r.employerFica + r.medicare + r.employerMedicare);
    });
    notes.push('Line 1 counts everyone paid in the quarter; the IRS asks for those paid for the pay period including the 12th of the quarter’s last month — check it before filing.');
    notes.push('Social Security wages assume each person is under the year’s wage base unless their Social Security tax stopped; review anyone near it.');
    return {
      ...base,
      totals: {
        line1_employees: employees,
        line2_wages: wages,
        line3_federalIncomeTax: fit,
        line5a_socialSecurityWages: ssWages,
        line5a_socialSecurityTax: line5aCol2,
        line5c_medicareWages: medWages,
        line5c_medicareTax: line5cCol2,
        line5d_additionalMedicareTax: line5dCol2,
        line6_totalBeforeAdjustments: line6,
        line7_fractionsOfCents: line7,
        line12_totalTax: line12,
        line13_deposits: deposits,
        line14_balanceDue: round2(Math.max(0, line12 - deposits)),
        line15_overpayment: round2(Math.max(0, deposits - line12)),
        month1_liability: monthly[0]!,
        month2_liability: monthly[1]!,
        month3_liability: monthly[2]!,
        taxDue: line12,
      },
      rows: [],
      notes,
    };
  }

  if (kind === 'F940') {
    const items = await paidItems(db, b.start, b.endExclusive);
    const byPerson = new Map<string, number>();
    for (const i of items) byPerson.set(i.associateId, (byPerson.get(i.associateId) ?? 0) + i.grossPay - (i.preTaxDeductions - i.preTaxRetirement));
    const totalPayments = round2([...byPerson.values()].reduce((a, v) => a + v, 0));
    const over7000 = round2([...byPerson.values()].reduce((a, v) => a + Math.max(0, v - 7000), 0));
    const taxable = round2(totalPayments - over7000);
    const tax = round2(taxable * 0.006);
    const deposits = await depositsMade(db, 'FEDERAL_UNEMPLOYMENT', 'US', b.start, b.endExclusive);
    notes.push('Credit-reduction states raise the FUTA rate for wages paid there; the Department of Labor names them each November — add Schedule A if any apply.');
    return {
      ...base,
      totals: { line3_totalPayments: totalPayments, line5_paymentsOver7000: over7000, line7_taxableFutaWages: taxable, line8_futaTax: tax, line13_deposits: deposits, line14_balanceDue: round2(Math.max(0, tax - deposits)), line15_overpayment: round2(Math.max(0, deposits - tax)), taxDue: tax, posted: sum(items, (r) => r.employerFuta) },
      rows: [],
      notes,
    };
  }

  if (kind === 'STATE_WH_QUARTERLY' || kind === 'STATE_WH_ANNUAL') {
    const st = jurisdiction.toUpperCase();
    if (NO_INCOME_TAX_STATES.has(st)) notes.push(`${STATE_NAMES[st] ?? st} has no wage income tax — there is nothing to file.`);
    const items = (await paidItems(db, b.start, b.endExclusive)).filter((i) => i.taxState === st);
    const wages = sum(items, (r) => r.grossPay - r.preTaxDeductions);
    const withheld = sum(items, (r) => r.stateWithholding);
    const deposits = await depositsMade(db, 'STATE_WITHHOLDING', st, b.start, b.endExclusive);
    const people = new Map<string, { name: string; last4: string | null; wages: number; withheld: number }>();
    for (const i of items) {
      const p = people.get(i.associateId) ?? { name: `${i.lastName}, ${i.firstName}`, last4: i.ssnLast4, wages: 0, withheld: 0 };
      p.wages += i.grossPay - i.preTaxDeductions;
      p.withheld += i.stateWithholding;
      people.set(i.associateId, p);
    }
    return {
      ...base,
      totals: { employees: people.size, stateWages: wages, stateTaxWithheld: withheld, deposits, balanceDue: round2(Math.max(0, withheld - deposits)), overpayment: round2(Math.max(0, deposits - withheld)), taxDue: withheld },
      rows: kind === 'STATE_WH_ANNUAL' ? [...people.values()].sort((x, y) => x.name.localeCompare(y.name)).map((p) => ({ name: p.name, ssnLast4: p.last4, stateWages: round2(p.wages), stateTaxWithheld: round2(p.withheld) })) : [],
      notes,
    };
  }

  if (kind === 'SUI_WAGE_REPORT') {
    const st = jurisdiction.toUpperCase();
    const yearStart = new Date(Date.UTC(b.start.getUTCFullYear(), 0, 1));
    const before = (await paidItems(db, yearStart, b.start)).filter((i) => i.taxState === st);
    const inQuarter = (await paidItems(db, b.start, b.endExclusive, true)).filter((i) => i.taxState === st);
    const account = await db.taxAgencyAccount.findFirst({ where: { tenantId: tenantIdForWrite(), kind: 'STATE_UNEMPLOYMENT', jurisdiction: st, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'asc' } });
    const defaults = sutaDefaults(st);
    const wageBase = account?.wageBase ? Number(account.wageBase) : (defaults?.wageBase ?? 0);
    const rate = account?.rate ? Number(account.rate) : (defaults?.rate ?? 0);
    if (!account?.wageBase) notes.push(`Wage base ${wageBase ? `$${wageBase.toLocaleString('en-US')}` : 'not set'} is the state default — enter this year’s on the agency account.`);
    if (!account?.rate) notes.push(`Rate ${(rate * 100).toFixed(2)}% is the new-employer default — enter your assigned rate on the agency account.`);
    const ytdBefore = new Map<string, number>();
    for (const i of before) ytdBefore.set(i.associateId, (ytdBefore.get(i.associateId) ?? 0) + i.grossPay - (i.preTaxDeductions - i.preTaxRetirement));
    const people = new Map<string, { first: string; last: string; ssn: string | null; last4: string | null; wages: number }>();
    for (const i of inQuarter) {
      const p = people.get(i.associateId) ?? { first: i.firstName, last: i.lastName, ssn: i.ssn, last4: i.ssnLast4, wages: 0 };
      p.wages += i.grossPay - (i.preTaxDeductions - i.preTaxRetirement);
      people.set(i.associateId, p);
    }
    // Weeks and hours worked in the quarter, from approved time (several states ask for one or the other).
    const ids = [...people.keys()];
    const entries = ids.length
      ? await db.timeEntry.findMany({ where: { associateId: { in: ids }, status: 'APPROVED', clockInAt: { gte: b.start, lt: b.endExclusive }, clockOutAt: { not: null } }, select: { associateId: true, clockInAt: true, clockOutAt: true } })
      : [];
    const weeks = new Map<string, Set<string>>();
    const hours = new Map<string, number>();
    for (const e of entries) {
      const d = new Date(Date.UTC(e.clockInAt.getUTCFullYear(), e.clockInAt.getUTCMonth(), e.clockInAt.getUTCDate()));
      const weekStart = new Date(d.getTime() - d.getUTCDay() * 86_400_000).toISOString().slice(0, 10);
      const set = weeks.get(e.associateId) ?? new Set<string>();
      set.add(weekStart);
      weeks.set(e.associateId, set);
      hours.set(e.associateId, (hours.get(e.associateId) ?? 0) + (e.clockOutAt!.getTime() - e.clockInAt.getTime()) / 3_600_000);
    }
    const rows = [...people.entries()]
      .sort((x, y) => `${x[1].last} ${x[1].first}`.localeCompare(`${y[1].last} ${y[1].first}`))
      .map(([id, p]) => {
        const prior = ytdBefore.get(id) ?? 0;
        const taxable = wageBase > 0 ? Math.max(0, Math.min(wageBase, prior + p.wages) - prior) : p.wages;
        return {
          ssn: p.ssn,
          ssnLast4: p.last4,
          lastName: p.last,
          firstName: p.first,
          quarterWages: round2(p.wages),
          excessWages: round2(p.wages - taxable),
          taxableWages: round2(taxable),
          weeksWorked: weeks.get(id)?.size ?? 0,
          hoursWorked: round2(hours.get(id) ?? 0),
        };
      });
    const totalWages = round2(rows.reduce((a, r) => a + r.quarterWages, 0));
    const taxableWages = round2(rows.reduce((a, r) => a + r.taxableWages, 0));
    const contribution = round2(taxableWages * rate);
    const posted = sum(inQuarter, (r) => r.employerSuta);
    const deposits = await depositsMade(db, 'STATE_UNEMPLOYMENT', st, b.start, b.endExclusive);
    if (rows.some((r) => !r.ssn)) notes.push(`${rows.filter((r) => !r.ssn).length} ${rows.filter((r) => !r.ssn).length === 1 ? 'person has' : 'people have'} no readable SSN on file — the state will reject those rows until it is collected.`);
    return {
      ...base,
      totals: { employees: rows.length, totalWages, excessWages: round2(totalWages - taxableWages), taxableWages, rate, contributionDue: contribution, posted, deposits, balanceDue: round2(Math.max(0, contribution - deposits)), taxDue: contribution },
      rows,
      notes,
    };
  }

  if (kind === 'LOCAL_QUARTERLY') {
    const items = (await paidItems(db, b.start, b.endExclusive)).filter((i) => i.localJurisdiction === jurisdiction);
    const people = new Map<string, { name: string; last4: string | null; wages: number; withheld: number }>();
    for (const i of items) {
      const p = people.get(i.associateId) ?? { name: `${i.lastName}, ${i.firstName}`, last4: i.ssnLast4, wages: 0, withheld: 0 };
      p.wages += i.grossPay - i.preTaxDeductions;
      p.withheld += i.localWithholding;
      people.set(i.associateId, p);
    }
    const withheld = sum(items, (r) => r.localWithholding);
    const deposits = await depositsMade(db, 'LOCAL', jurisdiction, b.start, b.endExclusive);
    return {
      ...base,
      totals: { employees: people.size, localWages: sum(items, (r) => r.grossPay - r.preTaxDeductions), localTaxWithheld: withheld, deposits, balanceDue: round2(Math.max(0, withheld - deposits)), taxDue: withheld },
      rows: [...people.values()].sort((x, y) => x.name.localeCompare(y.name)).map((p) => ({ name: p.name, ssnLast4: p.last4, localWages: round2(p.wages), localTaxWithheld: round2(p.withheld) })),
      notes,
    };
  }

  throw new HttpError(400, 'amend_instead', 'An amended return is made from the original: use Amend on the filed return.');
}

/** An amendment: the original's figures, the corrected figures now, and the difference. */
export async function amendReturn(db: Db, originalId: string): Promise<GeneratedReturn & { originalId: string; delta: Record<string, number> }> {
  const original = await db.taxReturn.findFirst({ where: { id: originalId, tenantId: tenantIdForWrite() } });
  if (!original) throw new HttpError(404, 'return_not_found', 'Return not found.');
  if (original.status !== 'FILED' && original.status !== 'ACCEPTED') throw new HttpError(409, 'not_filed', 'Only a filed return is amended. Regenerate a draft instead.');
  if (original.kind === 'F941X' || original.kind === 'STATE_AMENDED') throw new HttpError(409, 'amend_original', 'Amend the original return, not an amendment.');
  const corrected = await generateReturn(db, original.kind as ReturnKind, original.jurisdiction, original.periodLabel);
  const was = ((original.data as { totals?: Record<string, number> }).totals ?? {}) as Record<string, number>;
  const delta: Record<string, number> = {};
  for (const k of new Set([...Object.keys(was), ...Object.keys(corrected.totals)])) {
    const d = round2((corrected.totals[k] ?? 0) - (was[k] ?? 0));
    if (d !== 0) delta[k] = d;
  }
  return {
    ...corrected,
    kind: original.kind === 'F941' ? 'F941X' : 'STATE_AMENDED',
    originalId,
    delta,
    totals: { ...corrected.totals, taxDue: delta.taxDue ?? 0 },
    notes: [...corrected.notes, Object.keys(delta).length ? 'Explain each correction on the amended return before filing.' : 'Nothing has changed since the original was filed — no amendment is needed.'],
  };
}

export const ROW_COLUMN_ORDER = ['ssn', 'ssnLast4', 'lastName', 'firstName', 'name', 'quarterWages', 'excessWages', 'taxableWages', 'weeksWorked', 'hoursWorked', 'stateWages', 'stateTaxWithheld', 'localWages', 'localTaxWithheld'];

/** CSV for a return: the figures, then the per-person rows. SSNs appear only when `withSsn` (a bulk-PII export). */
export function returnCsv(r: { kind: string; jurisdiction: string; periodLabel: string; data: unknown }, withSsn: boolean): string {
  const data = r.data as { totals?: Record<string, number>; rows?: Array<Record<string, unknown>>; notes?: string[] };
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push(`# ${RETURN_LABEL[r.kind as ReturnKind] ?? r.kind} · ${r.jurisdiction} · ${r.periodLabel}`);
  if (r.kind === 'SUI_WAGE_REPORT' || r.kind === 'LOCAL_QUARTERLY') lines.push('# CONFIRM format: each agency prescribes its own electronic layout; these columns carry every field it asks for.');
  lines.push('figure,amount');
  for (const [k, v] of Object.entries(data.totals ?? {})) lines.push(`${esc(k)},${esc(v)}`);
  const rows = data.rows ?? [];
  if (rows.length) {
    lines.push('');
    // Postgres jsonb does not keep key order: put the columns back in the agency's reading order.
    const rank = (c: string) => (ROW_COLUMN_ORDER.indexOf(c) === -1 ? 99 : ROW_COLUMN_ORDER.indexOf(c));
    const cols = Object.keys(rows[0]!).filter((c) => withSsn || c !== 'ssn').sort((x, y) => rank(x) - rank(y));
    lines.push(cols.join(','));
    for (const row of rows) lines.push(cols.map((c) => esc(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

/* ----- Reconciliation ------------------------------------------------------------ */

export interface ReconLine {
  kind: TaxAgencyKind;
  jurisdiction: string;
  agencyLabel: string;
  posted: number;
  paid: number;
  open: number;
  latePayments: number;
  returnKind: ReturnKind | null;
  returnTax: number | null;
  returnStatus: string | null;
  flags: string[];
}

/** For a quarter: what payroll posted, what was paid, what the return says — and where they disagree. */
export async function reconcile(db: Db, periodLabel: string): Promise<ReconLine[]> {
  const tenantId = tenantIdForWrite();
  const liabilities = await db.taxLiability.findMany({ where: { tenantId, periodLabel }, include: { payment: { select: { paidAt: true, dueDate: true, status: true } } } });
  const returns = await db.taxReturn.findMany({ where: { tenantId, periodLabel, status: { not: 'SUPERSEDED' } }, orderBy: { createdAt: 'desc' } });
  const groups = new Map<string, typeof liabilities>();
  for (const l of liabilities) {
    const k = `${l.kind}|${l.jurisdiction}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const returnKindFor = (kind: TaxAgencyKind): ReturnKind | null =>
    kind === 'FEDERAL_WITHHOLDING' ? 'F941' : kind === 'STATE_WITHHOLDING' ? 'STATE_WH_QUARTERLY' : kind === 'STATE_UNEMPLOYMENT' ? 'SUI_WAGE_REPORT' : kind === 'LOCAL' ? 'LOCAL_QUARTERLY' : null;
  const out: ReconLine[] = [];
  for (const [k, rows] of [...groups.entries()].sort()) {
    const [kind, jurisdiction] = k.split('|') as [TaxAgencyKind, string];
    const posted = round2(rows.reduce((a, r) => a + Number(r.amount), 0));
    const paid = round2(rows.filter((r) => r.status === 'PAID').reduce((a, r) => a + Number(r.amount), 0));
    const late = rows.filter((r) => r.status === 'PAID' && r.payment?.paidAt && r.payment.paidAt > r.dueDate).length;
    const rk = returnKindFor(kind);
    const ret = rk ? returns.find((r) => r.kind === rk && r.jurisdiction === jurisdiction) : undefined;
    const retTax = ret ? Number(((ret.data as { totals?: Record<string, number> }).totals ?? {}).taxDue ?? 0) : null;
    const flags: string[] = [];
    if (round2(posted - paid) > 0.009) flags.push(`$${round2(posted - paid).toFixed(2)} not paid yet`);
    if (late) flags.push(`${late} paid after the due date`);
    // The 941's line 12 counts both halves of FICA and Medicare, as the ledger does.
    if (ret && retTax !== null && Math.abs(retTax - posted) > 1) flags.push(`Return says $${retTax.toFixed(2)}; payroll posted $${posted.toFixed(2)}`);
    if (rk && !ret) flags.push('No return generated for this quarter yet');
    out.push({ kind, jurisdiction, agencyLabel: kind === 'LOCAL' ? jurisdiction.replace(':', ' · ') : jurisdiction === 'US' ? 'IRS' : (STATE_NAMES[jurisdiction] ?? jurisdiction), posted, paid, open: round2(posted - paid), latePayments: late, returnKind: rk, returnTax: retTax, returnStatus: ret?.status ?? null, flags });
  }
  return out;
}
