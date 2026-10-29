import type { Prisma, PrismaClient } from '@prisma/client';
import type { ExecFinancials, ExecFinanceWeek, ExecKpi, ExecWaterfallStep } from '@alto-people/shared';
import { prorateTarget } from './execPeriods.js';
import { executiveMoney } from './executiveMoney.js';
import { zonedWallTimeToUtcInstant, localDateKey } from './timezone.js';
import { fmtDay, fmtDayRange } from './humanDates.js';
import { agingNow, bankBalances, dsoAsOf, execMoney } from './execFinance.js';
import { planField, type ExecContext } from './execFinanceContext.js';
import { KPI_SPECS, buildKpi, computeExecOverview, type OverviewExtras } from './execOverview.js';
import type { ExecOverview } from '@alto-people/shared';
import type { CashForecast } from './cashForecast.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The chairman's Financials page (GET /executive/financials, 2026-10-27):
 * the headline money measures, the margin walk for the period (billed →
 * base pay → overtime premium → employer burden → overhead → margin), the
 * last 13 weeks, cash and its 13-week forecast, receivables by age, what
 * each payroll run cost, and month-to-date profit from the books.
 *
 * The measures are the overview's own (computeExecOverview), so the
 * scorecard and this page never disagree; the walk's steps are the same
 * hours priced the same way, rounded to the cent so they add up exactly.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const statementNo = (n: number | null) => (n === null ? '—' : `No. ${String(n).padStart(4, '0')}`);

export async function computeExecFinancials(
  db: Db,
  ctx: ExecContext,
  opts: { overview?: { overview: ExecOverview; extras: OverviewExtras }; forecast?: Promise<CashForecast | null> } = {},
): Promise<ExecFinancials> {
  const { w, tz, now, tenantId } = ctx;
  const today = localDateKey(now, tz);
  const [ov, money, bankToday] = await Promise.all([
    opts.overview ? Promise.resolve(opts.overview) : computeExecOverview(db, ctx, { forecast: opts.forecast }),
    executiveMoney(db, now),
    bankBalances(db, tenantId, [today]),
  ]);
  const { overview, extras } = ov;
  const byId = new Map(overview.scorecard.map((k) => [k.id, k]));
  const current = extras.current;
  const planMode = overview.comparison.key === 'plan';

  // ---- gross margin $, beside the overview's measures
  const marginTarget = prorateTarget(planField(ctx, 'margin'), w.from, w.to, tz);
  const qLabel = ctx.quarterKeys.length === 1 ? `Q${ctx.quarterKeys[0]!.slice(-1)}` : `Q${ctx.quarterKeys[0]!.slice(-1)}–Q${ctx.quarterKeys[ctx.quarterKeys.length - 1]!.slice(-1)}`;
  const qMargin = ctx.quarterKeys.reduce((n, k) => n + (ctx.plan.get(k)?.margin ?? 0), 0);
  const grossMargin = buildKpi(KPI_SPECS.grossMargin, {
    value: current.margin,
    compare: planMode ? marginTarget : overview.comparison.available && extras.compared ? extras.compared.margin : null,
    target: marginTarget,
    targetLabel: marginTarget !== null ? `${qLabel} plan ${execMoney(qMargin)}, prorated to ${w.period.complete ? fmtDayRange(w.period.start, w.period.end) : fmtDay(w.period.end)}` : null,
    sub: current.billed > 0 ? `${((current.margin / current.billed) * 100).toFixed(1)}% of revenue` : null,
    trend: ctx.weekStarts.map((s, i) => ({ start: localDateKey(s, tz), value: extras.weekly[i]!.hours > 0 ? extras.weekly[i]!.margin : null })),
  });
  const kpis: ExecKpi[] = [byId.get('revenue')!, grossMargin, byId.get('marginPct')!, byId.get('overtimePct')!, byId.get('cash')!, byId.get('dso')!];

  // ---- the margin walk, to the cent, adding up exactly
  const billed = r2(current.billed);
  const basePay = r2(current.basePay);
  const overtimePremium = r2(current.otPremium);
  const burden = r2(current.burden);
  const overhead = r2(current.overhead);
  const waterfall: ExecWaterfallStep[] = [
    { key: 'billed', label: 'Billed', amount: billed },
    { key: 'basePay', label: 'Base pay', amount: basePay },
    { key: 'overtimePremium', label: 'Overtime premium', amount: overtimePremium },
    { key: 'burden', label: 'Employer burden', amount: burden },
    { key: 'overhead', label: 'Overhead', amount: overhead },
    { key: 'margin', label: 'Margin', amount: r2(billed - basePay - overtimePremium - burden - overhead) },
  ];

  // ---- the 13 weeks
  const weeks: ExecFinanceWeek[] = ctx.weekStarts.map((s, i) => {
    const x = extras.weekly[i]!;
    return {
      start: localDateKey(s, tz),
      billed: r2(x.billed),
      cost: r2(x.cost),
      margin: r2(x.margin),
      marginPct: x.billed > 0 ? Math.round((x.margin / x.billed) * 1000) / 10 : null,
      hours: r2(x.hours),
      otHours: r2(x.otHours),
    };
  });

  // ---- cash
  const forecast = extras.forecast;
  const todayBalance = bankToday?.byDay.get(today) ?? null;
  const cash: ExecFinancials['cash'] =
    bankToday || forecast?.opening
      ? {
          today: todayBalance,
          accounts: bankToday?.accounts ?? forecast?.opening?.accounts ?? 0,
          minimum: forecast?.minimumCash ?? null,
          forecast: (forecast?.weeks ?? []).map((wk) => ({ weekStart: wk.weekStart, balance: r2(wk.balance) })),
          lowPoint: forecast?.lowest ? { weekStart: forecast.lowest.weekStart, balance: r2(forecast.lowest.balance), belowMinimum: forecast.lowest.belowMinimum } : null,
        }
      : null;

  // ---- receivables
  const aging = agingNow(ctx.ar, now);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const dsoByMonth: ExecFinancials['receivables']['dsoByMonth'] = [];
  for (let i = 5; i >= 0; i--) {
    const mm = m - i;
    const year = mm <= 0 ? y - 1 : y;
    const month = ((mm - 1 + 12) % 12) + 1;
    const end = i === 0 ? now : zonedWallTimeToUtcInstant(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1, 0, tz);
    const days = dsoAsOf(ctx.ar, end);
    dsoByMonth.push({ month: `${year}-${String(month).padStart(2, '0')}`, days: days === null ? null : Math.round(days) });
  }
  const receivables: ExecFinancials['receivables'] = {
    total: r2(aging.total),
    buckets: {
      current: r2(aging.buckets.current),
      days1to30: r2(aging.buckets.days1to30),
      days31to60: r2(aging.buckets.days31to60),
      days61to90: r2(aging.buckets.days61to90),
      over90: r2(aging.buckets.over90),
    },
    open: aging.statements.slice(0, 8).map(({ row, ageDays, dueOn }) => ({
      statementId: row.id,
      clientName: row.clientName,
      number: statementNo(row.number),
      amount: r2(row.open),
      dueOn: dueOn ?? localDateKey(row.periodEnd, 'UTC'),
      ageDays,
    })),
    dsoByMonth,
  };

  return {
    period: overview.period,
    comparison: overview.comparison,
    kpis,
    waterfall,
    weeks,
    cash,
    receivables,
    payrollRuns: money.payrollRuns.map(({ costPerPerson: _cpp, ...r }) => r),
    profit: money.profit,
    rates: ctx.rates,
  };
}
