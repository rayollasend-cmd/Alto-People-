import type { Prisma, PrismaClient, TaxAgencyKind } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { tryDecryptString } from './crypto.js';
import { annualDueDate, periodBounds, quarterlyDueDate } from './payrollTaxCalendar.js';
import { NO_INCOME_TAX_STATES, STATE_NAMES, localJurisdictionOf } from './payrollTaxLedger.js';
import { FUTA_CREDIT_REDUCTION, futaCreditReduction, sutaDefaults } from './payrollTax.js';
import { loadItemBases, type ItemBases } from './wageBases.js';
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
 *   STATE_PROGRAM_REPORT a state disability / paid-leave program's report
 *                        (WA PFML, CO FAMLI, OR, MA, CT, NJ TDI/FLI …)
 *
 * Every figure is a sum of paid checks' wage bases (lib/wageBases): the
 * itemized deduction lines decide what each tax's wages were, and the tax
 * engine's lines decide which state and locality they belong to.
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

export const RETURN_KINDS = ['F941', 'F940', 'STATE_WH_QUARTERLY', 'STATE_WH_ANNUAL', 'SUI_WAGE_REPORT', 'STATE_PROGRAM_REPORT', 'LOCAL_QUARTERLY', 'F941X', 'STATE_AMENDED'] as const;
export type ReturnKind = (typeof RETURN_KINDS)[number];

export const RETURN_LABEL: Record<ReturnKind, string> = {
  F941: 'Form 941 — quarterly federal',
  F940: 'Form 940 — annual federal unemployment',
  STATE_WH_QUARTERLY: 'State withholding return',
  STATE_WH_ANNUAL: 'State annual reconciliation',
  SUI_WAGE_REPORT: 'State unemployment wage report',
  STATE_PROGRAM_REPORT: 'State disability / paid-leave report',
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
    // A paid-leave program files with the state's employment agency (WA ESD, CO FAMLI …): grouped with unemployment.
    case 'SUI_WAGE_REPORT':
    case 'STATE_PROGRAM_REPORT':
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

/** A paid check's wage bases (lib/wageBases), with the person's identity for wage reports. */
interface Paid extends ItemBases {
  firstName: string;
  lastName: string;
  ssn: string | null;
  ssnLast4: string | null;
  localRule: string | null;
}

/** Disbursed pay with a disbursement date in [from, toExclusive). */
async function paidChecks(db: Db, from: Date, toExclusive: Date, withSsn = false): Promise<Paid[]> {
  const bases = await loadItemBases(db, { tenantId: tenantIdForWrite(), status: 'DISBURSED', payrollRun: { disbursedAt: { gte: from, lt: toExclusive } } });
  const ids = [...new Set(bases.map((b) => b.associateId))];
  const people = ids.length
    ? await db.associate.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          ssnLast4: true,
          localTaxRule: { select: { state: true, name: true } },
          ...(withSsn ? { w4Submission: { select: { ssnEncrypted: true } } } : {}),
        },
      })
    : [];
  const byId = new Map(people.map((p) => [p.id, p as typeof p & { w4Submission?: { ssnEncrypted: Uint8Array | null } | null }]));
  return bases.map((b) => {
    const a = byId.get(b.associateId);
    const enc = a?.w4Submission?.ssnEncrypted;
    return {
      ...b,
      firstName: a?.firstName ?? '',
      lastName: a?.lastName ?? '',
      ssn: enc ? tryDecryptString(Buffer.from(enc)) : null,
      ssnLast4: a?.ssnLast4 ?? null,
      localRule: localJurisdictionOf(a?.localTaxRule),
    };
  });
}

const sum = <T>(rows: T[], f: (r: T) => number) => round2(rows.reduce((a, r) => a + f(r), 0));

/** Payments recorded as paid to an agency for a period (the deposits a return credits). */
async function depositsMade(db: Db, kind: TaxAgencyKind, jurisdiction: string, from: Date, toExclusive: Date): Promise<number> {
  const rows = await db.taxLiability.findMany({
    where: { tenantId: tenantIdForWrite(), kind, jurisdiction, status: 'PAID', liabilityDate: { gte: from, lt: toExclusive } },
    select: { amount: true },
  });
  return round2(rows.reduce((a, r) => a + Number(r.amount), 0));
}

/** Social Security wage base and Additional Medicare threshold for a year. */
async function yearLimits(db: Db, year: number): Promise<{ ssWageBase: number; addlMedicareThreshold: number }> {
  const row = await db.payrollConfig.findUnique({ where: { year }, select: { ssWageBase: true, medicareSurchargeThreshold: true } });
  return { ssWageBase: row ? Number(row.ssWageBase) : 184_500, addlMedicareThreshold: row ? Number(row.medicareSurchargeThreshold) : 200_000 };
}

/** Per person: wages already paid this year before `from` under a base, then the amount of this period's wages that fall under a cap. */
function cappedThisPeriod(prior: number, now: number, cap: number): number {
  return Math.max(0, Math.min(cap, prior + now) - Math.min(cap, prior));
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export interface GeneratedReturn {
  kind: ReturnKind;
  jurisdiction: string;
  periodLabel: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  /** The headline figures (what reconciliation compares). */
  totals: Record<string, number>;
  /** The per-person rows where the return has them (wage reports, annual reconciliations, locals; Schedule B days for a 941). */
  rows: Array<Record<string, string | number | null>>;
  notes: string[];
}

/** Does a local tax line belong to a return's jurisdiction key (the ledger's "PA:Pittsburgh", or the engine's code)? */
function localMatches(p: Paid, jurisdiction: string): Array<{ wages: number; withheld: number }> {
  const out: Array<{ wages: number; withheld: number }> = [];
  for (const l of p.locals) {
    if (l.employer) continue;
    const keys = [l.code, `${l.state ?? ''}:${l.label}`];
    if (keys.includes(jurisdiction) || (l.code === 'LOCAL' && p.localRule === jurisdiction)) out.push({ wages: l.wages, withheld: l.withheld });
  }
  return out;
}

/** Build a return's figures from disbursed pay. Every figure is the sum of paid checks' bases (lib/wageBases). */
export async function generateReturn(db: Db, kind: ReturnKind, jurisdiction: string, periodLabel: string): Promise<GeneratedReturn> {
  const b = periodBounds(periodLabel);
  const annualKinds: ReturnKind[] = ['F940', 'STATE_WH_ANNUAL'];
  if (annualKinds.includes(kind) !== b.annual) throw new HttpError(400, 'wrong_period', annualKinds.includes(kind) ? 'This return is annual: give a year like 2026.' : 'This return is quarterly: give a quarter like 2026-Q4.');
  const base = { kind, jurisdiction, periodLabel, periodStart: b.start, periodEnd: b.end, dueDate: returnDueDate(kind, periodLabel) };
  const notes: string[] = [];
  const year = b.start.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));

  if (kind === 'F941') {
    const items = await paidChecks(db, b.start, b.endExclusive);
    const prior = await paidChecks(db, yearStart, b.start);
    const { ssWageBase, addlMedicareThreshold } = await yearLimits(db, year);
    // Line 1: people paid for the pay period that includes the 12th of the quarter's last month.
    const twelfth = new Date(Date.UTC(year, b.start.getUTCMonth() + 2, 12));
    const runs = items.length ? await db.payrollRun.findMany({ where: { id: { in: [...new Set(items.map((i) => i.runId))] } }, select: { id: true, periodStart: true, periodEnd: true } }) : [];
    const covering = new Set(runs.filter((r) => r.periodStart <= twelfth && r.periodEnd >= twelfth).map((r) => r.id));
    const line1 = covering.size ? new Set(items.filter((i) => covering.has(i.runId)).map((i) => i.associateId)).size : new Set(items.map((i) => i.associateId)).size;
    if (!covering.size) notes.push('No pay period this quarter includes the 12th of its last month; line 1 counts everyone paid in the quarter — check it before filing.');

    // Per person: Social Security wages and tips to the wage base; Medicare wages over the Additional Medicare threshold.
    const per = new Map<string, { ss: number; tips: number; med: number; priorSs: number; priorTips: number; priorMed: number; subjectSs: boolean }>();
    const get = (id: string) => {
      let v = per.get(id);
      if (!v) per.set(id, (v = { ss: 0, tips: 0, med: 0, priorSs: 0, priorTips: 0, priorMed: 0, subjectSs: false }));
      return v;
    };
    for (const i of prior) {
      const v = get(i.associateId);
      if (i.ssEmployee + i.ssEmployer > 0) {
        v.priorSs += i.ssWages - i.tips;
        v.priorTips += i.tips;
      }
      v.priorMed += i.medicareWages;
    }
    for (const i of items) {
      const v = get(i.associateId);
      // A worker exempt from Social Security (no tax either side) has no line-5a wages.
      if (i.ssEmployee + i.ssEmployer > 0) {
        v.subjectSs = true;
        v.ss += i.ssWages - i.tips;
        v.tips += i.tips;
      }
      v.med += i.medicareWages;
    }
    let line5aWages = 0;
    let line5bTips = 0;
    let line5dWages = 0;
    let line5cWages = 0;
    for (const v of per.values()) {
      if (v.subjectSs || v.ss || v.tips) {
        const wagesTaxed = cappedThisPeriod(v.priorSs + v.priorTips, v.ss, ssWageBase);
        line5aWages += wagesTaxed;
        line5bTips += cappedThisPeriod(v.priorSs + v.priorTips + v.ss, v.tips, ssWageBase);
      }
      line5cWages += v.med;
      line5dWages += Math.max(0, v.priorMed + v.med - Math.max(addlMedicareThreshold, v.priorMed));
    }
    line5aWages = round2(line5aWages);
    line5bTips = round2(line5bTips);
    line5cWages = round2(line5cWages);
    line5dWages = round2(line5dWages);
    const wages = sum(items, (r) => r.fitWages);
    const fit = sum(items, (r) => r.fit);
    const line5aCol2 = round2(line5aWages * 0.124);
    const line5bCol2 = round2(line5bTips * 0.124);
    const line5cCol2 = round2(line5cWages * 0.029);
    const line5dCol2 = round2(line5dWages * 0.009);
    const line5e = round2(line5aCol2 + line5bCol2 + line5cCol2 + line5dCol2);
    const line6 = round2(fit + line5e);
    const actualTotal = sum(items, (r) => r.fit + r.ssEmployee + r.ssEmployer + r.medicareEmployee + r.medicareEmployer);
    // Line 7: the cents lost rounding each check's half-taxes, so line 10 equals what was actually withheld and owed.
    const line7 = round2(actualTotal - line6);
    const line10 = round2(line6 + line7);
    const line12 = line10;
    const deposits = await depositsMade(db, 'FEDERAL_WITHHOLDING', 'US', b.start, b.endExclusive);
    const liability = (r: Paid) => r.fit + r.ssEmployee + r.ssEmployer + r.medicareEmployee + r.medicareEmployer;
    const monthly = [0, 1, 2].map((m) => {
      const from = new Date(Date.UTC(year, b.start.getUTCMonth() + m, 1));
      const to = new Date(Date.UTC(year, b.start.getUTCMonth() + m + 1, 1));
      return sum(items.filter((i) => i.paidAt >= from && i.paidAt < to), liability);
    });
    // Schedule B (semiweekly depositors): the liability on each payday.
    const byDay = new Map<string, number>();
    for (const i of items) byDay.set(dayKey(i.paidAt), (byDay.get(dayKey(i.paidAt)) ?? 0) + liability(i));
    if (line12 >= 2500) notes.push('Line 12 is $2,500 or more: semiweekly depositors attach Schedule B (each payday’s liability is listed with this return); monthly depositors complete line 16.');
    return {
      ...base,
      totals: {
        line1_employees: line1,
        line2_wages: wages,
        line3_federalIncomeTax: fit,
        line5a_socialSecurityWages: line5aWages,
        line5a_socialSecurityTax: line5aCol2,
        line5b_socialSecurityTips: line5bTips,
        line5b_socialSecurityTipsTax: line5bCol2,
        line5c_medicareWages: line5cWages,
        line5c_medicareTax: line5cCol2,
        line5d_additionalMedicareWages: line5dWages,
        line5d_additionalMedicareTax: line5dCol2,
        line5e_totalSocialSecurityMedicare: line5e,
        line6_totalBeforeAdjustments: line6,
        line7_fractionsOfCents: line7,
        line10_totalAfterAdjustments: line10,
        line12_totalTax: line12,
        line13_deposits: deposits,
        line14_balanceDue: round2(Math.max(0, line12 - deposits)),
        line15_overpayment: round2(Math.max(0, deposits - line12)),
        month1_liability: monthly[0]!,
        month2_liability: monthly[1]!,
        month3_liability: monthly[2]!,
        taxDue: line12,
      },
      rows: [...byDay.entries()].sort().map(([day, amount]) => ({ day, liability: round2(amount) })),
      notes,
    };
  }

  if (kind === 'F940') {
    const items = await paidChecks(db, b.start, b.endExclusive);
    // Line 3: all payments to employees. Line 4: payments exempt from FUTA (§125 benefits, dependent care,
    // and anything else whose deduction line lowered FUTA — employee 401(k) deferrals stay FUTA wages).
    const per = new Map<string, { gross: number; futa: number; byQuarter: number[]; state: string | null }>();
    for (const i of items) {
      const v = per.get(i.associateId) ?? { gross: 0, futa: 0, byQuarter: [0, 0, 0, 0], state: i.suiState };
      v.gross += i.gross;
      v.futa += i.futaWages;
      v.byQuarter[Math.floor(i.paidAt.getUTCMonth() / 3)]! += i.futaWages;
      v.state = i.suiState ?? v.state;
      per.set(i.associateId, v);
    }
    let line3 = 0;
    let line4 = 0;
    let line5 = 0;
    const quarterTaxable = [0, 0, 0, 0];
    const taxableByState = new Map<string, number>();
    for (const v of per.values()) {
      line3 += v.gross;
      line4 += v.gross - v.futa;
      line5 += Math.max(0, v.futa - 7000);
      // Taxable FUTA wages fall in the quarters they were paid, until the $7,000 is reached.
      let running = 0;
      v.byQuarter.forEach((q, idx) => {
        const t = cappedThisPeriod(running, q, 7000);
        quarterTaxable[idx]! += t;
        running += q;
      });
      const taxable = Math.min(7000, v.futa);
      if (v.state) taxableByState.set(v.state, (taxableByState.get(v.state) ?? 0) + taxable);
    }
    line3 = round2(line3);
    line4 = round2(line4);
    line5 = round2(line5);
    const line6 = round2(line4 + line5);
    const line7 = round2(line3 - line6);
    const line8 = round2(line7 * 0.006);
    // Schedule A: wages in a credit-reduction state pay that state's reduction on top.
    let line11 = 0;
    const scheduleA: Array<{ state: string; taxableWages: number; rate: number; amount: number }> = [];
    for (const [st, wages] of [...taxableByState.entries()].sort()) {
      const rate = futaCreditReduction(st, year);
      if (rate > 0) {
        const amount = round2(wages * rate);
        line11 += amount;
        scheduleA.push({ state: st, taxableWages: round2(wages), rate, amount });
      }
    }
    line11 = round2(line11);
    const line12 = round2(line8 + line11);
    const deposits = await depositsMade(db, 'FEDERAL_UNEMPLOYMENT', 'US', b.start, b.endExclusive);
    const reduction = FUTA_CREDIT_REDUCTION[year];
    if (scheduleA.length) notes.push(`Schedule A: ${scheduleA.map((s) => `${s.state} ${(s.rate * 100).toFixed(1)}%`).join(', ')}.${reduction && !reduction.final ? ' The Department of Labor confirms the year’s list on November 10 — regenerate after that.' : ''}`);
    else notes.push(reduction && !reduction.final ? 'The Department of Labor names credit-reduction states each November 10 — regenerate the 940 after that date.' : 'No credit-reduction state applies.');
    if (taxableByState.size > 1) notes.push('Wages were paid in more than one state: check Schedule A, part 1 (multi-state employer) before filing.');
    return {
      ...base,
      totals: {
        line3_totalPayments: line3,
        line4_exemptPayments: line4,
        line5_paymentsOver7000: line5,
        line6_subtotal: line6,
        line7_taxableFutaWages: line7,
        line8_futaTax: line8,
        line11_creditReduction: line11,
        line12_totalFutaTax: line12,
        line13_deposits: deposits,
        line14_balanceDue: round2(Math.max(0, line12 - deposits)),
        line15_overpayment: round2(Math.max(0, deposits - line12)),
        line16a_q1Liability: round2(quarterTaxable[0]! * 0.006),
        line16b_q2Liability: round2(quarterTaxable[1]! * 0.006),
        line16c_q3Liability: round2(quarterTaxable[2]! * 0.006),
        line16d_q4Liability: round2(quarterTaxable[3]! * 0.006),
        taxDue: line12,
        posted: sum(items, (r) => r.futaEmployer),
      },
      rows: scheduleA,
      notes,
    };
  }

  if (kind === 'STATE_WH_QUARTERLY' || kind === 'STATE_WH_ANNUAL') {
    const st = jurisdiction.toUpperCase();
    if (NO_INCOME_TAX_STATES.has(st)) notes.push(`${STATE_NAMES[st] ?? st} has no wage income tax — there is nothing to file.`);
    const items = await paidChecks(db, b.start, b.endExclusive);
    const people = new Map<string, { name: string; last4: string | null; wages: number; withheld: number; resident: boolean }>();
    for (const i of items) {
      for (const line of i.states.filter((x) => x.state === st)) {
        const p = people.get(i.associateId) ?? { name: `${i.lastName}, ${i.firstName}`, last4: i.ssnLast4, wages: 0, withheld: 0, resident: false };
        p.wages += line.wages;
        p.withheld += line.withheld;
        p.resident ||= line.resident;
        people.set(i.associateId, p);
      }
    }
    const wages = round2([...people.values()].reduce((a, p) => a + p.wages, 0));
    const withheld = round2([...people.values()].reduce((a, p) => a + p.withheld, 0));
    const deposits = await depositsMade(db, 'STATE_WITHHOLDING', st, b.start, b.endExclusive);
    return {
      ...base,
      totals: { employees: people.size, stateWages: wages, stateTaxWithheld: withheld, deposits, balanceDue: round2(Math.max(0, withheld - deposits)), overpayment: round2(Math.max(0, deposits - withheld)), taxDue: withheld },
      rows: kind === 'STATE_WH_ANNUAL' ? [...people.values()].sort((x, y) => x.name.localeCompare(y.name)).map((p) => ({ name: p.name, ssnLast4: p.last4, resident: p.resident ? 'Yes' : 'No', stateWages: round2(p.wages), stateTaxWithheld: round2(p.withheld) })) : [],
      notes,
    };
  }

  if (kind === 'SUI_WAGE_REPORT') {
    const st = jurisdiction.toUpperCase();
    const before = (await paidChecks(db, yearStart, b.start)).filter((i) => i.suiState === st);
    const inQuarter = (await paidChecks(db, b.start, b.endExclusive, true)).filter((i) => i.suiState === st);
    const account = await db.taxAgencyAccount.findFirst({ where: { tenantId: tenantIdForWrite(), kind: 'STATE_UNEMPLOYMENT', jurisdiction: st, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'asc' } });
    const defaults = sutaDefaults(st);
    const wageBase = account?.wageBase ? Number(account.wageBase) : (defaults?.wageBase ?? 0);
    const rate = account?.rate ? Number(account.rate) : (defaults?.rate ?? 0);
    if (!account?.wageBase) notes.push(`Wage base ${wageBase ? `$${wageBase.toLocaleString('en-US')}` : 'not set'} is the state default — enter this year’s on the agency account.`);
    if (!account?.rate) notes.push(`Rate ${(rate * 100).toFixed(2)}% is the new-employer default — enter your assigned rate on the agency account.`);
    const ytdBefore = new Map<string, number>();
    for (const i of before) ytdBefore.set(i.associateId, (ytdBefore.get(i.associateId) ?? 0) + i.suiWages);
    const people = new Map<string, { first: string; last: string; ssn: string | null; last4: string | null; wages: number }>();
    for (const i of inQuarter) {
      const p = people.get(i.associateId) ?? { first: i.firstName, last: i.lastName, ssn: i.ssn, last4: i.ssnLast4, wages: 0 };
      p.wages += i.suiWages;
      people.set(i.associateId, p);
    }
    const { weeks, hours } = await weeksAndHours(db, [...people.keys()], b.start, b.endExclusive);
    const rows = [...people.entries()]
      .sort((x, y) => `${x[1].last} ${x[1].first}`.localeCompare(`${y[1].last} ${y[1].first}`))
      .map(([id, p]) => {
        const prior = ytdBefore.get(id) ?? 0;
        const taxable = wageBase > 0 ? cappedThisPeriod(prior, p.wages, wageBase) : p.wages;
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
    const posted = sum(inQuarter, (r) => r.sutaEmployer);
    const deposits = await depositsMade(db, 'STATE_UNEMPLOYMENT', st, b.start, b.endExclusive);
    if (rows.some((r) => !r.ssn)) notes.push(`${rows.filter((r) => !r.ssn).length} ${rows.filter((r) => !r.ssn).length === 1 ? 'person has' : 'people have'} no readable SSN on file — the state will reject those rows until it is collected.`);
    return {
      ...base,
      totals: { employees: rows.length, totalWages, excessWages: round2(totalWages - taxableWages), taxableWages, rate, contributionDue: contribution, posted, deposits, balanceDue: round2(Math.max(0, contribution - deposits)), taxDue: contribution },
      rows,
      notes,
    };
  }

  if (kind === 'STATE_PROGRAM_REPORT') {
    // A state disability / paid-leave program's quarterly report (WA PFML and Cares, CO FAMLI, OR PFML,
    // MA PFML, CT PFML, NJ TDI/FLI on the WR-30, DE, MN …): each person's subject wages, hours and contributions.
    const st = jurisdiction.toUpperCase();
    const items = await paidChecks(db, b.start, b.endExclusive, true);
    const people = new Map<string, Record<string, string | number | null>>();
    const codes = new Map<string, { wages: number; employee: number; employer: number }>();
    for (const i of items) {
      for (const p of i.programs.filter((x) => (x.state ?? x.code.slice(0, 2)).toUpperCase() === st)) {
        const key = `${i.associateId}|${p.code}`;
        const row = people.get(key) ?? { ssn: i.ssn, ssnLast4: i.ssnLast4, lastName: i.lastName, firstName: i.firstName, program: p.code, subjectWages: 0, employeeContribution: 0, employerContribution: 0, associateId: i.associateId };
        row.subjectWages = round2(Number(row.subjectWages) + p.wages);
        row.employeeContribution = round2(Number(row.employeeContribution) + p.employee);
        row.employerContribution = round2(Number(row.employerContribution) + p.employer);
        people.set(key, row);
        const c = codes.get(p.code) ?? { wages: 0, employee: 0, employer: 0 };
        c.wages += p.wages;
        c.employee += p.employee;
        c.employer += p.employer;
        codes.set(p.code, c);
      }
    }
    const { hours } = await weeksAndHours(db, [...new Set([...people.values()].map((r) => String(r.associateId)))], b.start, b.endExclusive);
    const rows = [...people.values()]
      .map((r): Record<string, string | number | null> => {
        const { associateId, ...rest } = r;
        return { ...rest, hoursWorked: round2(hours.get(String(associateId)) ?? 0) };
      })
      .sort((x, y) => `${x.lastName} ${x.firstName} ${x.program}`.localeCompare(`${y.lastName} ${y.firstName} ${y.program}`));
    const totals: Record<string, number> = { employees: new Set([...people.keys()].map((k) => k.split('|')[0])).size };
    let due = 0;
    for (const [code, c] of [...codes.entries()].sort()) {
      totals[`${code}_subjectWages`] = round2(c.wages);
      totals[`${code}_employee`] = round2(c.employee);
      totals[`${code}_employer`] = round2(c.employer);
      due += c.employee + c.employer;
    }
    totals.taxDue = round2(due);
    if (!codes.size) notes.push(`No ${STATE_NAMES[st] ?? st} disability or paid-leave contributions were withheld this quarter.`);
    notes.push('CONFIRM format: each program prescribes its own upload (WA ESD, CO FAMLI, OR, MA DFML, CT, NJ WR-30); these rows carry every field they ask for.');
    return { ...base, totals, rows, notes };
  }

  if (kind === 'LOCAL_QUARTERLY') {
    const items = await paidChecks(db, b.start, b.endExclusive);
    const people = new Map<string, { name: string; last4: string | null; wages: number; withheld: number }>();
    for (const i of items) {
      for (const m of localMatches(i, jurisdiction)) {
        const p = people.get(i.associateId) ?? { name: `${i.lastName}, ${i.firstName}`, last4: i.ssnLast4, wages: 0, withheld: 0 };
        p.wages += m.wages;
        p.withheld += m.withheld;
        people.set(i.associateId, p);
      }
    }
    const withheld = round2([...people.values()].reduce((a, p) => a + p.withheld, 0));
    const deposits = await depositsMade(db, 'LOCAL', jurisdiction, b.start, b.endExclusive);
    return {
      ...base,
      totals: { employees: people.size, localWages: round2([...people.values()].reduce((a, p) => a + p.wages, 0)), localTaxWithheld: withheld, deposits, balanceDue: round2(Math.max(0, withheld - deposits)), taxDue: withheld },
      rows: [...people.values()].sort((x, y) => x.name.localeCompare(y.name)).map((p) => ({ name: p.name, ssnLast4: p.last4, localWages: round2(p.wages), localTaxWithheld: round2(p.withheld) })),
      notes,
    };
  }

  throw new HttpError(400, 'amend_instead', 'An amended return is made from the original: use Amend on the filed return.');
}

/** Weeks and hours worked in a period, from approved time (several states ask for one or the other). */
async function weeksAndHours(db: Db, ids: string[], from: Date, toExclusive: Date): Promise<{ weeks: Map<string, Set<string>>; hours: Map<string, number> }> {
  const entries = ids.length
    ? await db.timeEntry.findMany({ where: { associateId: { in: ids }, status: 'APPROVED', clockInAt: { gte: from, lt: toExclusive }, clockOutAt: { not: null } }, select: { associateId: true, clockInAt: true, clockOutAt: true } })
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
  return { weeks, hours };
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

export const ROW_COLUMN_ORDER = ['day', 'liability', 'state', 'ssn', 'ssnLast4', 'lastName', 'firstName', 'name', 'resident', 'program', 'quarterWages', 'excessWages', 'taxableWages', 'subjectWages', 'weeksWorked', 'hoursWorked', 'employeeContribution', 'employerContribution', 'stateWages', 'stateTaxWithheld', 'localWages', 'localTaxWithheld', 'rate', 'amount'];

/** CSV for a return: the figures, then the per-person rows. SSNs appear only when `withSsn` (a bulk-PII export). */
export function returnCsv(r: { kind: string; jurisdiction: string; periodLabel: string; data: unknown }, withSsn: boolean): string {
  const data = r.data as { totals?: Record<string, number>; rows?: Array<Record<string, unknown>>; notes?: string[] };
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push(`# ${RETURN_LABEL[r.kind as ReturnKind] ?? r.kind} · ${r.jurisdiction} · ${r.periodLabel}`);
  if (r.kind === 'SUI_WAGE_REPORT' || r.kind === 'LOCAL_QUARTERLY' || r.kind === 'STATE_PROGRAM_REPORT') lines.push('# CONFIRM format: each agency prescribes its own electronic layout; these columns carry every field it asks for.');
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
