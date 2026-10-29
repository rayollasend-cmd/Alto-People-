import { prisma } from '../db.js';
import type { TaxAgencyAccount } from '@prisma/client';
import { orgDateKey } from './timeAnomalies.js';
import { round2 } from './payroll.js';
import { nextPaydayOn, periodAfter, scheduleFilterFor } from './payScheduleMembership.js';
import { agencyNameFor, dueFor, employerFor } from './payrollTaxLedger.js';
import { runCutFor } from './payrollRunCut.js';
import { aggregatePayrollProjection } from './payrollAggregator.js';
import { cashOnHand } from './books/ledger.js';
import { tenantIdForWrite } from './tenant.js';
import { fmtDay, fmtDayRange } from './humanDates.js';
import { quarterWords } from './books/words.js';

/**
 * The cash forecast: where the money stands and what leaves and arrives
 * over the next weeks, from the records that already know —
 *
 *   opening balance  the Books cash position today: every bank account's
 *                    ledger balance, less the card balances (the same
 *                    number the Books overview shows)
 *   payroll          the next two paydays: the run that exists for the
 *                    period (its net), else a projection of the open
 *                    period, else the last run paid. A payday is NEVER
 *                    skipped: with nobody on the schedule and no run, the
 *                    line is the last run's net, marked estimated and
 *                    flagged "0 people on schedule" (audit 2026-10-21 #18)
 *   tax              the tax desk's open liabilities (every agency) on
 *                    their due dates, older FED_941 / FUTA rows the desk
 *                    never itemized, and the federal deposit each forecast
 *                    payday will create — dated on the IRS account's
 *                    schedule, as the desk dates it
 *   garnishments     pending remittances, assumed a week after payday
 *   bills            approved, unpaid vendor bills on their due date
 *                    (overdue ones expected this week)
 *   retirement       401(k)/403(b) money withheld and matched but not yet
 *                    sent to the recordkeeper (RetirementContribution rows
 *                    on no SENT file), a few days after its payday; and,
 *                    for each forecast payday, the same share of net the
 *                    last paid run sent (estimated)
 *   benefit carriers each carrier's monthly premium on the 1st: the active
 *                    insurance elections' employee + employer share per
 *                    check, times checks a year over 12 (estimated). A
 *                    month already billed (an approved bill from a vendor
 *                    of the carrier's name) is left to the bill line
 *   receivables      unpaid FINAL statements on their due date (terms),
 *                    overdue ones expected within the week
 *
 * Each week carries its net movement, the running total of movement, and
 * the projected balance (opening + running total). The low point and the
 * cash floor (Settings → Finance) let the chart say when the balance dips
 * under the floor.
 */

export type CashLineKind = 'PAYROLL' | 'TAX_DEPOSIT' | 'GARNISHMENT' | 'RECEIVABLE' | 'BILL' | 'RETIREMENT' | 'BENEFITS';

export interface CashLine {
  date: string;
  kind: CashLineKind;
  label: string;
  /** Signed: money in positive, money out negative. */
  amount: number;
  /** scheduled = a record with a date and an amount; estimated = our projection; overdue = past due, expected soon. */
  confidence: 'scheduled' | 'estimated' | 'overdue';
  linkUrl: string;
  /** Why an estimate is what it is ("0 people on schedule — last run's net"). */
  warning?: string | null;
}

export interface CashWeek {
  weekStart: string;
  weekEnd: string;
  inflow: number;
  outflow: number;
  net: number;
  /** Running total of movement since today. */
  cumulative: number;
  /** Opening balance + cumulative: where the cash stands at the week's end. */
  balance: number;
}

export interface CashForecast {
  generatedAt: string;
  from: string;
  to: string;
  /** The Books cash position today (null when the books hold no bank account yet). */
  /** `onFile`: false when the bank accounts exist but nothing is posted to them (no opening balance, no feed). */
  /** `overdrawn`: bank accounts below zero today, which the balance nets away (MONEY-18). */
  opening: { balance: number; accounts: number; asOf: string; onFile: boolean; overdrawn?: Array<{ id: string; name: string; balance: number }> } | null;
  /** The cash floor from Settings → Finance; null when none is set. */
  minimumCash: number | null;
  /** The week the projected balance is lowest. */
  lowest: { weekStart: string; balance: number; belowMinimum: boolean } | null;
  weeks: CashWeek[];
  lines: CashLine[];
  totals: { inflow: number; outflow: number; net: number };
}

const DAY_MS = 86_400_000;
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: day arithmetic on YYYY-MM-DD keys anchored at noon UTC.
  return d.toISOString().slice(0, 10);
};
// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: @db.Date values (due dates, pay dates) are stored at UTC midnight; instants use orgDateKey.
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);

/** "2026-Q4" → "Oct–Dec 2026" (lib/books/words, MONEY-24). */
export { quarterWords };

/** Days after a payday the plan's money is sent to the recordkeeper (DOL: as soon as it can be segregated). */
export const RETIREMENT_REMIT_LAG_DAYS = 3;
/** How far back an unsent contribution still counts as owed (older ones were sent outside Alto). */
const RETIREMENT_LOOKBACK_DAYS = 45;
const CHECKS_PER_YEAR: Record<string, number> = { WEEKLY: 52, BIWEEKLY: 26, SEMIMONTHLY: 24, MONTHLY: 12 };
/** Plans whose premium goes to an insurance carrier (HSA / FSA / retirement money goes elsewhere). */
const CARRIER_PLAN_KINDS = ['HEALTH_MEDICAL', 'DENTAL', 'VISION', 'LIFE_INSURANCE', 'DISABILITY'] as const;

type ContributionRow = {
  preTax: unknown;
  roth: unknown;
  catchUpPreTax: unknown;
  catchUpRoth: unknown;
  employerMatch: unknown;
  safeHarbor: unknown;
  loanRepayments: unknown;
};
/** Everything one paycheck sends the plan: deferrals, catch-up, match, safe harbor and loan repayments. */
export function contributionTotal(c: ContributionRow): number {
  const loans = Array.isArray(c.loanRepayments)
    ? (c.loanRepayments as Array<{ amount?: unknown }>).reduce((sum, l) => sum + (Number(l?.amount) || 0), 0)
    : 0;
  return Number(c.preTax) + Number(c.roth) + Number(c.catchUpPreTax) + Number(c.catchUpRoth) + Number(c.employerMatch) + Number(c.safeHarbor) + loans;
}

export async function cashForecast(now: Date = new Date(), opts: { tenantId?: string; weeks?: number } = {}): Promise<CashForecast> {
  const T = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const horizonWeeks = opts.weeks ?? 4;
  // The company's day (its zone), not the server default's.
  const today = orgDateKey(now);
  const end = addDays(today, horizonWeeks * 7);
  const lines: CashLine[] = [];
  const inHorizon = (ymd: string) => ymd >= today && ymd < end;

  // ---- Where the cash stands: the books ---------------------------------
  const [cash, org] = await Promise.all([
    cashOnHand(prisma, today).catch(() => null),
    prisma.orgSetting.findFirst({ where: { tenantId: opts.tenantId ?? tenantIdForWrite() }, select: { cashMinimum: true } }),
  ]);
  const opening = cash && cash.accounts > 0 ? { balance: cash.total, accounts: cash.accounts, asOf: today, onFile: cash.postedAccounts > 0, overdrawn: cash.overdrawn } : null;
  const minimumCash = org?.cashMinimum != null ? Number(org.cashMinimum) : null;

  // ---- Payroll: the next two paydays of every active schedule ------------
  // Each schedule pays its own members (audit 2026-10-29 MONEY-14): the open
  // period is projected exactly as Payroll's "next run" projects it (the
  // schedule's membership windows and run cut), so the same payroll never
  // reads two different totals on two screens.
  const schedules = await prisma.payrollSchedule.findMany({
    where: { isActive: true, deletedAt: null, ...T },
    orderBy: [{ clientId: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    include: { versions: true },
  });
  const schedule = schedules[0] ?? null;
  const [lastRun, profile] = await Promise.all([
    prisma.payrollRun.findFirst({ where: { ...T, status: 'DISBURSED', kind: 'REGULAR' }, orderBy: { disbursedAt: 'desc' }, select: { id: true, totalNet: true, totalTax: true, totalGross: true, items: { select: { employerFica: true, employerMedicare: true, fica: true, medicare: true, federalWithholding: true }, take: 10_000 } } }),
    prisma.submitterProfile.findUnique({ where: { tenantId: opts.tenantId ?? tenantIdForWrite() }, select: { depositSchedule: true } }),
  ]);
  // The federal deposit schedule is the IRS agency account's — the one the
  // tax desk dates its liabilities by (lib/payrollTaxLedger.dueFor), not the
  // submitter profile's (audit 2026-10-29 MONEY-6). With no account yet, the
  // desk's own default applies (semiweekly when the profile says so).
  const fedAccountFor = async (clientId: string | null): Promise<TaxAgencyAccount> => {
    const employerOrgId = await employerFor(prisma, clientId);
    const found = await prisma.taxAgencyAccount.findFirst({
      where: { ...T, kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', employerOrgId, status: { in: ['ACTIVE', 'PENDING_REGISTRATION'] } },
      orderBy: { createdAt: 'asc' },
    });
    return found ?? ({ kind: 'FEDERAL_WITHHOLDING', depositFrequency: profile?.depositSchedule === 'SEMIWEEKLY' ? 'SEMIWEEKLY' : 'MONTHLY', dueDayOfMonth: 15 } as unknown as TaxAgencyAccount);
  };
  // The federal deposit a payday creates, as a share of net, from the last run paid.
  let depositPerNet = 0;
  if (lastRun && Number(lastRun.totalNet) > 0) {
    const fed = lastRun.items.reduce(
      (s, i) => s + Number(i.federalWithholding) + Number(i.fica) + Number(i.medicare) + Number(i.employerFica) + Number(i.employerMedicare),
      0,
    );
    depositPerNet = fed / Number(lastRun.totalNet);
  }
  // What the last paid run sent the retirement plans, as a share of its net:
  // each forecast payday sends about the same.
  let retirementPerNet = 0;
  if (lastRun && Number(lastRun.totalNet) > 0) {
    const sent = await prisma.retirementContribution.findMany({
      where: { ...T, payrollRunId: lastRun.id },
      select: { preTax: true, roth: true, catchUpPreTax: true, catchUpRoth: true, employerMatch: true, safeHarbor: true, loanRepayments: true },
      take: 10_000,
    });
    retirementPerNet = sent.reduce((sum, c) => sum + contributionTotal(c), 0) / Number(lastRun.totalNet);
  }

  for (const sched of schedules) {
    const first = nextPaydayOn(sched, today);
    const windows = [first, periodAfter(sched, first)];
    const named = schedules.length > 1 ? ` · ${sched.name}` : '';
    const fedAccount = await fedAccountFor(sched.clientId);
    for (const [i, win] of windows.entries()) {
      if (!inHorizon(win.payDate)) continue;
      const ps = new Date(`${win.periodStart}T00:00:00Z`);
      const pe = new Date(`${win.periodEnd}T00:00:00Z`);
      pe.setUTCDate(pe.getUTCDate() + 1);
      // The period's run: this schedule's own, else one tied to no schedule for the same client (Payroll's rule).
      const candidates = await prisma.payrollRun.findMany({
        where: {
          ...T,
          periodStart: ps,
          status: { in: ['DRAFT', 'FINALIZED', 'DISBURSED'] },
          OR: [{ kind: 'REGULAR' }, { includesApprovedTime: true }],
          AND: [{ OR: [{ payrollScheduleId: sched.id }, { payrollScheduleId: null, ...(sched.clientId ? { clientId: sched.clientId } : {}) }] }],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, payrollScheduleId: true, totalNet: true, totalTax: true, items: { select: { fica: true, medicare: true, federalWithholding: true, employerFica: true, employerMedicare: true }, take: 10_000 } },
      });
      const run = candidates.find((r) => r.payrollScheduleId === sched.id) ?? candidates[0] ?? null;
      if (run?.status === 'DISBURSED') continue; // already out the door
      let net = 0;
      let confidence: CashLine['confidence'];
      let fed: number | null = null;
      let warning: string | null = null;
      if (run) {
        net = Number(run.totalNet);
        fed = run.items.reduce((s, x) => s + Number(x.federalWithholding) + Number(x.fica) + Number(x.medicare) + Number(x.employerFica) + Number(x.employerMedicare), 0);
        confidence = run.status === 'FINALIZED' ? 'scheduled' : 'estimated';
      } else {
        confidence = 'estimated';
        const filter = await scheduleFilterFor(prisma, sched.id, ps, new Date(`${win.periodEnd}T00:00:00Z`)).catch(() => null);
        if (i === 0 && filter) {
          // The open period: project the schedule's members from approved hours so far.
          try {
            const { cut, payDate } = await runCutFor(prisma, { kind: 'REGULAR', payrollScheduleId: sched.id, clientId: sched.clientId, periodStart: win.periodStart, periodEnd: win.periodEnd, windows: filter.windows });
            const proj = await aggregatePayrollProjection(prisma, { periodStart: ps, periodEndExclusive: pe, clientId: sched.clientId, defaultRate: 15, scheduleFilter: filter, payDate, prevUtcCut: cut.prevUtc });
            net = proj.totals.totalNet;
            fed = proj.items.reduce((s, x) => s + x.federalIncomeTax + x.fica + x.medicare + x.employerFica + x.employerMedicare, 0);
            // A period that is barely begun projects low; the last run is the better guess until it is half over.
            const daysIn = Math.max(0, (Date.parse(`${today}T00:00:00Z`) - ps.getTime()) / DAY_MS);
            const days = Math.max(1, (pe.getTime() - ps.getTime()) / DAY_MS);
            if (lastRun && daysIn / days < 0.5 && net < Number(lastRun.totalNet) * 0.5) {
              net = Number(lastRun.totalNet);
              fed = null;
              warning = 'Period just begun — the last run’s net';
            }
          } catch {
            net = 0;
          }
        }
        // Nobody on the schedule yet (or nothing approved): the payday still comes. The last
        // run's net is the estimate, and the line says so — never dropped from the picture.
        if (net <= 0) {
          const people = filter ? filter.windows.size : 0;
          net = lastRun ? Number(lastRun.totalNet) : 0;
          fed = null;
          warning = `${people} ${people === 1 ? 'person' : 'people'} on schedule — ${lastRun ? 'the last run’s net' : 'no run paid yet to estimate from'}`;
        }
      }
      lines.push({
        date: win.payDate,
        kind: 'PAYROLL',
        label: `Payroll ${fmtDayRange(win.periodStart, win.periodEnd)}${named}${run ? ` (${run.status.toLowerCase()})` : ' (projected)'}`,
        amount: -round2(net),
        confidence,
        linkUrl: run ? `/payroll?run=${run.id}` : '/payroll',
        warning,
      });
      const deposit = round2(fed ?? net * depositPerNet);
      if (deposit > 0) {
        const due = ymdOf(dueFor(fedAccount, new Date(`${win.payDate}T12:00:00Z`), deposit));
        if (inHorizon(due)) {
          lines.push({
            date: due,
            kind: 'TAX_DEPOSIT',
            label: `Federal deposit for the ${fmtDay(win.payDate)} payday`,
            amount: -deposit,
            confidence: 'estimated',
            linkUrl: '/payroll/taxes?tab=deposits',
          });
        }
      }
      const retirement = round2(net * retirementPerNet);
      const remitOn = addDays(win.payDate, RETIREMENT_REMIT_LAG_DAYS);
      if (retirement > 0 && inHorizon(remitOn)) {
        lines.push({
          date: remitOn,
          kind: 'RETIREMENT',
          label: `Retirement plan contributions from the ${fmtDay(win.payDate)} payday`,
          amount: -retirement,
          confidence: 'estimated',
          linkUrl: '/payroll/retirement',
        });
      }
    }
  }

  // ---- Tax already owed: the tax desk's liabilities -----------------------
  // Every agency's open liability on its due date (MONEY-6): federal, FUTA,
  // state withholding and unemployment, local — the desk's own dates.
  const liabilities = await prisma.taxLiability.findMany({
    where: { ...T, status: { in: ['OPEN', 'SCHEDULED'] }, dueDate: { lt: new Date(`${end}T00:00:00Z`) } },
    select: { id: true, kind: true, jurisdiction: true, periodLabel: true, dueDate: true, amount: true, payrollRunId: true, account: { select: { agencyName: true } } },
  });
  for (const l of liabilities) {
    const due = ymdOf(l.dueDate);
    const overdue = due < today;
    lines.push({
      date: overdue ? today : due,
      kind: 'TAX_DEPOSIT',
      label: `${l.account?.agencyName ?? agencyNameFor(l.kind, l.jurisdiction)} — ${quarterWords(l.periodLabel)}${overdue ? ' (past due)' : ''}`,
      amount: -round2(Number(l.amount)),
      confidence: overdue ? 'overdue' : 'scheduled',
      linkUrl: '/payroll/taxes?tab=deposits',
    });
  }
  // Older per-run deposits, only where the desk never itemized the run (or, for FUTA, the year) — never counted twice.
  const itemized = new Set(
    (await prisma.taxLiability.findMany({ where: { ...T, payrollRunId: { not: null } }, select: { payrollRunId: true }, distinct: ['payrollRunId'] })).map((r) => r.payrollRunId),
  );
  const futaYears = new Set((await prisma.taxLiability.findMany({ where: { ...T, kind: 'FEDERAL_UNEMPLOYMENT' }, select: { periodLabel: true }, distinct: ['periodLabel'] })).map((r) => r.periodLabel.slice(0, 4)));
  const deposits = await prisma.taxDeposit.findMany({
    where: { ...T, status: 'PENDING', dueDate: { lt: new Date(`${end}T00:00:00Z`) } },
    select: { id: true, kind: true, periodLabel: true, dueDate: true, amount: true, payrollRunId: true },
  });
  for (const d of deposits) {
    if (d.kind === 'FUTA' ? futaYears.has(d.periodLabel.slice(0, 4)) : d.payrollRunId !== null && itemized.has(d.payrollRunId)) continue;
    const due = ymdOf(d.dueDate);
    const overdue = due < today;
    lines.push({
      date: overdue ? today : due,
      kind: 'TAX_DEPOSIT',
      label: `${d.kind === 'FUTA' ? 'FUTA' : 'Federal 941'} deposit — ${d.periodLabel}${overdue ? ' (past due)' : ''}`,
      amount: -round2(Number(d.amount)),
      confidence: overdue ? 'overdue' : 'scheduled',
      linkUrl: '/payroll/taxes?tab=deposits',
    });
  }

  // ---- Garnishment remittances -------------------------------------------
  const remittances = await prisma.garnishmentRemittance.findMany({
    where: { ...T, status: 'PENDING' },
    select: { id: true, payeeName: true, amount: true, payrollRun: { select: { disbursedAt: true } } },
  });
  for (const r of remittances) {
    const base = r.payrollRun.disbursedAt ? orgDateKey(r.payrollRun.disbursedAt) : today;
    const due = addDays(base, 7);
    const date = due < today ? today : due;
    if (!inHorizon(date)) continue;
    lines.push({
      date,
      kind: 'GARNISHMENT',
      label: `Remit to ${r.payeeName}`,
      amount: -round2(Number(r.amount)),
      confidence: due < today ? 'overdue' : 'scheduled',
      linkUrl: '/payroll/garnishments?tab=remittances',
    });
  }

  // ---- Retirement plans: withheld and matched, not yet sent ---------------
  const unsent = await prisma.retirementContribution.findMany({
    where: { ...T, payDate: { gte: new Date(`${addDays(today, -RETIREMENT_LOOKBACK_DAYS)}T00:00:00Z`) } },
    select: { planId: true, payDate: true, fileId: true, preTax: true, roth: true, catchUpPreTax: true, catchUpRoth: true, employerMatch: true, safeHarbor: true, loanRepayments: true, plan: { select: { name: true } } },
    take: 20_000,
  });
  const fileIds = [...new Set(unsent.map((c) => c.fileId).filter((id): id is string => !!id))];
  const sentFiles = new Set(
    fileIds.length
      ? (await prisma.retirementFile.findMany({ where: { id: { in: fileIds }, status: 'SENT' }, select: { id: true } })).map((f) => f.id)
      : [],
  );
  const owedByPlanDay = new Map<string, { plan: string; payDate: string; amount: number }>();
  for (const c of unsent) {
    if (c.fileId && sentFiles.has(c.fileId)) continue;
    const payDate = ymdOf(c.payDate);
    const key = `${c.planId}|${payDate}`;
    const cur = owedByPlanDay.get(key) ?? { plan: c.plan.name, payDate, amount: 0 };
    cur.amount += contributionTotal(c);
    owedByPlanDay.set(key, cur);
  }
  for (const o of owedByPlanDay.values()) {
    const amount = round2(o.amount);
    if (amount <= 0) continue;
    const due = addDays(o.payDate, RETIREMENT_REMIT_LAG_DAYS);
    const overdue = due < today;
    const date = overdue ? today : due;
    if (!inHorizon(date)) continue;
    lines.push({
      date,
      kind: 'RETIREMENT',
      label: `${o.plan} — contributions from the ${fmtDay(o.payDate)} payday${overdue ? ' (not sent yet)' : ''}`,
      amount: -amount,
      confidence: overdue ? 'overdue' : 'scheduled',
      linkUrl: '/payroll/retirement',
    });
  }

  // ---- Vendor bills: approved and unpaid, on their due date ---------------
  const bills = await prisma.bill.findMany({
    where: { ...T, status: { in: ['APPROVED', 'PARTIALLY_PAID'] }, dueDate: { lt: new Date(`${end}T00:00:00Z`) } },
    select: { id: true, billNumber: true, dueDate: true, balance: true, vendor: { select: { name: true } } },
    take: 2000,
  });
  for (const b of bills) {
    const balance = Number(b.balance);
    if (balance <= 0) continue;
    const due = ymdOf(b.dueDate);
    const overdue = due < today;
    lines.push({
      date: overdue ? today : due,
      kind: 'BILL',
      label: `${b.vendor.name}${b.billNumber ? ` — invoice ${b.billNumber}` : ''}${overdue ? ' (past due)' : ''}`,
      amount: -round2(balance),
      confidence: overdue ? 'overdue' : 'scheduled',
      linkUrl: `/books/bills/${b.id}`,
    });
  }

  // ---- Benefit carriers: each month's premium on the 1st -------------------
  const firsts: string[] = [];
  for (let d = `${today.slice(0, 7)}-01`; d < end; ) {
    if (d >= today) firsts.push(d);
    const [y, m] = d.split('-').map(Number) as [number, number];
    d = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  if (firsts.length > 0) {
    const checksPerYear = CHECKS_PER_YEAR[schedule?.frequency ?? 'BIWEEKLY'] ?? 26;
    const elections = await prisma.benefitsEnrollment.findMany({
      where: {
        ...T,
        plan: { kind: { in: [...CARRIER_PLAN_KINDS] } },
        effectiveDate: { lte: new Date(`${firsts[firsts.length - 1]}T00:00:00Z`) },
        OR: [{ terminationDate: null }, { terminationDate: { gt: new Date(`${firsts[0]}T00:00:00Z`) } }],
        associate: { deletedAt: null },
      },
      select: {
        electedAmountCentsPerPeriod: true,
        effectiveDate: true,
        terminationDate: true,
        plan: { select: { name: true, carrierId: true, employerContributionCentsPerPeriod: true } },
      },
      take: 50_000,
    });
    const carrierIds = [...new Set(elections.map((e) => e.plan.carrierId).filter((id): id is string => !!id))];
    const carriers = carrierIds.length ? await prisma.benefitCarrier.findMany({ where: { id: { in: carrierIds } }, select: { id: true, name: true } }) : [];
    const carrierName = new Map(carriers.map((c) => [c.id, c.name]));
    const norm = (x: string) => x.trim().toLowerCase();
    const billed = new Set(bills.map((b) => `${norm(b.vendor.name)}|${ymdOf(b.dueDate).slice(0, 7)}`));
    for (const first of firsts) {
      const on = new Date(`${first}T00:00:00Z`);
      const byPayee = new Map<string, number>();
      for (const e of elections) {
        if (e.effectiveDate > on || (e.terminationDate && e.terminationDate <= on)) continue;
        const payee = (e.plan.carrierId && carrierName.get(e.plan.carrierId)) || e.plan.name;
        const perCheckCents = e.electedAmountCentsPerPeriod + e.plan.employerContributionCentsPerPeriod;
        byPayee.set(payee, (byPayee.get(payee) ?? 0) + perCheckCents);
      }
      for (const [payee, perCheckCents] of byPayee) {
        const monthly = round2((perCheckCents * checksPerYear) / 12 / 100);
        if (monthly <= 0) continue;
        if (billed.has(`${norm(payee)}|${first.slice(0, 7)}`)) continue; // the carrier's invoice is already a bill line
        lines.push({
          date: first,
          kind: 'BENEFITS',
          label: `${payee} premiums — ${new Date(`${first}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
          amount: -monthly,
          confidence: 'estimated',
          linkUrl: '/benefits/carriers',
        });
      }
    }
  }

  // ---- Receivables -------------------------------------------------------
  const [unpaid, paidRecent] = await Promise.all([
    prisma.clientStatement.findMany({
      where: { ...T, status: 'FINAL', paidAt: null },
      select: { id: true, number: true, clientId: true, finalizedAt: true, dueAt: true, snapshot: true, client: { select: { name: true, paymentTermsDays: true } } },
    }),
    prisma.clientStatement.findMany({
      where: { ...T, status: 'FINAL', paidAt: { not: null, gte: new Date(now.getTime() - 120 * DAY_MS) } },
      select: { finalizedAt: true, paidAt: true },
    }),
  ]);
  const lags = paidRecent.filter((s) => s.finalizedAt && s.paidAt).map((s) => (s.paidAt!.getTime() - s.finalizedAt!.getTime()) / DAY_MS);
  const avgDays = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null;
  for (const s of unpaid) {
    const snap = s.snapshot as { totals?: { amount?: number } } | null;
    const amount = typeof snap?.totals?.amount === 'number' ? snap.totals.amount : 0;
    if (amount <= 0) continue;
    const expected = s.dueAt
      ? ymdOf(s.dueAt)
      : s.finalizedAt
        ? addDays(orgDateKey(s.finalizedAt), avgDays ?? s.client.paymentTermsDays)
        : today;
    const overdue = expected < today;
    const date = overdue ? addDays(today, 6) : expected;
    if (!inHorizon(date)) continue;
    lines.push({
      date,
      kind: 'RECEIVABLE',
      label: `${s.client.name} — statement ${s.number !== null ? `No. ${String(s.number).padStart(4, '0')}` : 'draft'}${overdue ? ' (past due)' : ''}`,
      amount: round2(amount),
      confidence: overdue ? 'overdue' : s.dueAt ? 'scheduled' : 'estimated',
      linkUrl: `/clients/statements?statement=${s.id}`,
    });
  }

  lines.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));

  const weeks: CashWeek[] = [];
  let cumulative = 0;
  const base = opening?.balance ?? 0;
  for (let i = 0; i < horizonWeeks; i++) {
    const ws = addDays(today, i * 7);
    const we = addDays(ws, 6);
    const mine = lines.filter((l) => l.date >= ws && l.date <= we);
    const inflow = round2(mine.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0));
    const outflow = round2(mine.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0));
    const net = round2(inflow - outflow);
    cumulative = round2(cumulative + net);
    weeks.push({ weekStart: ws, weekEnd: we, inflow, outflow, net, cumulative, balance: round2(base + cumulative) });
  }
  const inflow = round2(lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0));
  const outflow = round2(lines.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0));
  const low = weeks.reduce<CashWeek | null>((m, w) => (m === null || w.balance < m.balance ? w : m), null);
  return {
    generatedAt: now.toISOString(),
    from: today,
    to: addDays(end, -1),
    opening,
    minimumCash,
    lowest: low ? { weekStart: low.weekStart, balance: low.balance, belowMinimum: minimumCash !== null && low.balance < minimumCash } : null,
    weeks,
    lines,
    totals: { inflow, outflow, net: round2(inflow - outflow) },
  };
}
