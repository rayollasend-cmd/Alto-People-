import type { Prisma, PrismaClient } from '@prisma/client';
import type { ExecCompareKey, ExecPeriodKey } from '@alto-people/shared';
import { lastCompleteWeeks, quarterOf, quartersBetween, resolveExecWindow, type ExecWindow } from './execPeriods.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { DAY_MS, execRates, laborBetween, loadArBook, loadLaborBook, loadPlan, planIsSet, covers, type ArBook, type ExecRates, type LaborBook, type LaborTotals, type QuarterPlan } from './execFinance.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * One reading of the company for an executive frame (2026-10-27): the
 * window, the plan, the punches split once and the statements — loaded
 * together so the overview, the financials page and the board pack (which
 * reads both) price the same hours the same way, and a request reads the
 * punches once for the widest span it needs (the 13 trend weeks, the
 * period and the comparison).
 */
export interface ExecContext {
  tenantId: string;
  now: Date;
  w: ExecWindow;
  tz: string;
  /** Quarter keys the period touches, in order; the last holds the period's end. */
  quarterKeys: string[];
  plan: Map<string, QuarterPlan>;
  planSet: boolean;
  /** The last 13 complete weeks' starts, oldest first, and the end of the last one. */
  weekStarts: Date[];
  weeksEnd: Date;
  labor: LaborBook;
  /** A separate book when the comparison lies far before the period (the same span last year). */
  compareLabor: LaborBook | null;
  ar: ArBook;
  rates: ExecRates;
}

export const TREND_WEEKS = 13;

export async function loadExecContext(db: Db, input: { tenantId: string; now: Date; period: ExecPeriodKey; compare: ExecCompareKey }): Promise<ExecContext> {
  const { tenantId, now } = input;
  const w0 = resolveExecWindow(input.period, input.compare, now, { planSet: false });
  const tz = w0.timezone;
  const quarterKeys = quartersBetween(w0.from, w0.to, tz).map((q) => q.key);
  if (quarterKeys.length === 0) quarterKeys.push(quarterOf(w0.from, tz).key);
  const weekStarts = lastCompleteWeeks(now, TREND_WEEKS);
  const weeksEnd = startOfWeekUTC(now);

  // The main book covers the trend weeks and the period; the comparison
  // joins it when it is near, or gets its own book when it is a year back.
  const mainFrom = new Date(Math.min(weekStarts[0]!.getTime(), w0.from.getTime()));
  const mainTo = new Date(Math.max(now.getTime(), w0.to.getTime()));
  let joined = mainFrom;
  let separate: { from: Date; to: Date } | null = null;
  if (w0.compareFrom && w0.compareTo && w0.compareFrom < mainFrom) {
    if (w0.compareTo.getTime() >= startOfWeekUTC(mainFrom).getTime() - 28 * DAY_MS) joined = w0.compareFrom;
    else separate = { from: w0.compareFrom, to: w0.compareTo };
  }

  const [plan, labor, compareLabor, ar] = await Promise.all([
    loadPlan(db, tenantId, quarterKeys),
    loadLaborBook(db, tenantId, joined, mainTo),
    separate ? loadLaborBook(db, tenantId, separate.from, separate.to) : Promise.resolve(null),
    loadArBook(db, tenantId),
  ]);
  const planSet = planIsSet(plan, quarterKeys);
  const w = resolveExecWindow(input.period, input.compare, now, { planSet, quarterKey: quarterKeys[quarterKeys.length - 1] });
  return { tenantId, now, w, tz, quarterKeys, plan, planSet, weekStarts, weeksEnd, labor, compareLabor, ar, rates: execRates() };
}

/** The labor in [from, to), from whichever book holds it. */
export function laborFor(ctx: ExecContext, from: Date, to: Date): LaborTotals {
  const book = covers(ctx.labor, from, to) || !ctx.compareLabor ? ctx.labor : ctx.compareLabor;
  return laborBetween(book, from, to, ctx.rates);
}

/** Each trend week's labor, oldest first. */
export function weeklyLabor(ctx: ExecContext): LaborTotals[] {
  return ctx.weekStarts.map((s, i) => laborFor(ctx, s, ctx.weekStarts[i + 1] ?? ctx.weeksEnd));
}

/** Each quarter's value of one plan field, for prorateTarget. */
export function planField(ctx: ExecContext, field: keyof QuarterPlan): Map<string, number | null> {
  return new Map(ctx.quarterKeys.map((k) => [k, ctx.plan.get(k)?.[field] ?? null]));
}

/** The plan value in force at the period's end (the last quarter it touches) — for measures that are levels, not sums. */
export function planAtEnd(ctx: ExecContext, field: keyof QuarterPlan): number | null {
  return ctx.plan.get(ctx.quarterKeys[ctx.quarterKeys.length - 1]!)?.[field] ?? null;
}
