import type { Prisma, PrismaClient } from '@prisma/client';
import { accountIndex } from './books/ledger.js';
import { profitAndLoss, trialBalance } from './books/reports.js';
import { budgetVsActual, listBudgets } from './books/budgets/budgets.js';
import { cashForecast } from './cashForecast.js';
import { tenantIdForWrite } from './tenant.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The executive view's money band (finance walk 17), every figure from a
 * record rather than an estimate:
 *
 *   cash          bank balances in the company's books (lib/books)
 *   lowPoint      the 13-week cash forecast's lowest projected balance
 *   profit        month-to-date net income (P&L) beside the budget for the year so far
 *   dso           average days from a statement going final to being paid, by month
 *   payrollRuns   what each recent payroll run cost: gross + employer taxes, per person
 *
 * Each part answers null when its source is empty (no books, no budget,
 * no paid statements) so the band says "not set up" rather than $0.
 */
export interface ExecutiveMoney {
  asOf: string;
  cash: { total: number; accounts: number } | null;
  lowPoint: { weekStart: string; balance: number; belowMinimum: boolean; minimumCash: number | null } | null;
  profit: { month: string; mtdNetIncome: number; ytd: { actual: number; budget: number; variance: number } | null; budgetName: string | null } | null;
  dso: Array<{ month: string; days: number | null; paid: number }>;
  payrollRuns: Array<{ runId: string; periodStart: string; periodEnd: string; people: number; gross: number; employerTaxes: number; cost: number; costPerPerson: number }>;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

async function cashToday(db: Db, asOf: string): Promise<ExecutiveMoney['cash']> {
  const { byId } = await accountIndex(db as PrismaClient);
  const banks = [...byId.values()].filter((a) => a.isActive && a.subtype === 'BANK');
  if (banks.length === 0) return null;
  const tb = await trialBalance(db as PrismaClient, asOf);
  const ids = new Set(banks.map((b) => b.id));
  const total = tb.rows.filter((r) => ids.has(r.accountId)).reduce((sum, r) => sum + r.debit - r.credit, 0);
  return { total: r2(total), accounts: banks.length };
}

export async function executiveMoney(db: Db, now: Date): Promise<ExecutiveMoney> {
  const tenantId = tenantIdForWrite();
  const asOf = ymd(now);
  const month = asOf.slice(0, 7);
  const monthStart = `${month}-01`;

  const [cash, forecast, pnl, budgets, statements, runs] = await Promise.all([
    cashToday(db, asOf).catch(() => null),
    cashForecast(now, { tenantId, weeks: 13 }).catch(() => null),
    profitAndLoss(db as PrismaClient, monthStart, asOf).catch(() => null),
    listBudgets(db as PrismaClient).catch(() => ({ budgets: [] })),
    db.clientStatement.findMany({
      where: { tenantId, status: 'FINAL', paidAt: { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)) }, finalizedAt: { not: null } },
      select: { finalizedAt: true, paidAt: true },
      take: 5000,
    }),
    db.payrollRun.findMany({
      where: { tenantId, kind: 'REGULAR', status: { in: ['FINALIZED', 'DISBURSED'] } },
      orderBy: { periodEnd: 'desc' },
      take: 8,
      select: { id: true, periodStart: true, periodEnd: true, items: { where: { status: { not: 'VOIDED' } }, select: { grossPay: true, employerFica: true, employerMedicare: true, employerFuta: true, employerSuta: true } } },
    }),
  ]);

  // The year's budget: the active one for this fiscal year, else any for it.
  const year = now.getUTCFullYear();
  const yearBudgets = (budgets as { budgets: Array<{ id: string; name: string; fiscalYear: number; status?: string }> }).budgets.filter((b) => b.fiscalYear === year);
  const budget = yearBudgets.find((b) => b.status === 'ACTIVE') ?? yearBudgets[0] ?? null;
  const bva = budget ? await budgetVsActual(db as PrismaClient, budget.id, month).catch(() => null) : null;

  const dso: ExecutiveMoney['dso'] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = ymd(d).slice(0, 7);
    const paid = statements.filter((s) => ymd(s.paidAt!).slice(0, 7) === key);
    const days = paid.length ? Math.round(paid.reduce((n, s) => n + (s.paidAt!.getTime() - s.finalizedAt!.getTime()) / 86_400_000, 0) / paid.length) : null;
    dso.push({ month: key, days, paid: paid.length });
  }

  return {
    asOf,
    cash,
    lowPoint: forecast?.lowest ? { weekStart: forecast.lowest.weekStart, balance: forecast.lowest.balance, belowMinimum: forecast.lowest.belowMinimum, minimumCash: forecast.minimumCash ?? null } : null,
    profit: pnl
      ? {
          month,
          mtdNetIncome: pnl.totals.netIncome,
          ytd: bva ? { actual: bva.netIncome.ytd.actual, budget: bva.netIncome.ytd.budget, variance: bva.netIncome.ytd.variance } : null,
          budgetName: budget?.name ?? null,
        }
      : null,
    dso,
    payrollRuns: runs
      .map((r) => {
        const gross = r.items.reduce((n, i) => n + Number(i.grossPay), 0);
        const er = r.items.reduce((n, i) => n + Number(i.employerFica) + Number(i.employerMedicare) + Number(i.employerFuta) + Number(i.employerSuta), 0);
        const cost = gross + er;
        return { runId: r.id, periodStart: ymd(r.periodStart), periodEnd: ymd(r.periodEnd), people: r.items.length, gross: r2(gross), employerTaxes: r2(er), cost: r2(cost), costPerPerson: r.items.length ? r2(cost / r.items.length) : 0 };
      })
      .reverse(),
  };
}
