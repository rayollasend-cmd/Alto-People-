import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { loadLiveRules } from './laborRules/live.js';
import { payFor, splitByPerson, type EntryHours, type HoursSplit, type LaborSite } from './laborRules/hours.js';
import { activeWindowDays, placements } from './activeDefinition.js';
import { ageStatements } from './books/aging.js';
import { statementAmounts } from './books/posting/statements.js';
import { localDateKey } from './timezone.js';

/**
 * The executive portal's money and labor engine (2026-10-27): the pieces
 * the overview, the financials page and the board pack all read, so a
 * figure on one is the figure on the others.
 *
 *   labor     every approved/completed punch in a span, split once per
 *             person exactly as pay splits it (lib/laborRules/hours), then
 *             priced at the standard rates — the executive summary's and the
 *             targets card's math, to the cent
 *   plan      the quarters' ExecTarget rows
 *   AR        finalized statements and what is still open on each, as of
 *             any day (lib/books/aging for the buckets) — DSO
 *   cash      the books' bank balances as of any day (the executive money
 *             band's "cash today" definition: active BANK accounts, posted)
 *   active    the one definition of active (lib/activeDefinition) read at
 *             several instants with one placement reading
 */

type Db = PrismaClient | Prisma.TransactionClient;
export const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ rates */

export interface ExecRates {
  billRate: number;
  payRate: number;
  burdenPct: number;
  overheadPerHour: number;
}

export function execRates(): ExecRates {
  return {
    billRate: env.DEFAULT_ASSOCIATE_BILL_RATE,
    payRate: env.DEFAULT_ASSOCIATE_PAY_RATE,
    burdenPct: env.LABOR_BURDEN_PERCENT,
    overheadPerHour: env.LABOR_OVERHEAD_PER_HOUR,
  };
}

/* ------------------------------------------------------------- formatting */

/** $22.6k · $181k · $1.24M · $640 — the web's fmtExecMoney, for API-written sentences. */
export function execMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '−' : '';
  const abs = Math.abs(value);
  const sig3 = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
  if (abs >= 1_000_000_000) return `${sign}$${sig3(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${sig3(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${sig3(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

/** Whole dollars with separators: "$22,649" (tables). */
export function wholeDollars(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const r = Math.round(value);
  return `${r < 0 ? '−' : ''}$${Math.abs(r).toLocaleString('en-US')}`;
}

/** "1 day" · "3 days" · "1 separation" — a count with its noun, plural when it should be. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${Math.abs(n) === 1 ? one : many}`;
}

/** Whole hours with separators: "1,234". */
export const wholeHours = (h: number) => Math.round(h).toLocaleString('en-US');

const r2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ labor */

export interface LaborEntry {
  associateId: string;
  clientId: string | null;
  locationId: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: Array<{ startedAt: Date; endedAt: Date | null }>;
  site: LaborSite | null;
}

export interface LaborBook {
  /** Sorted by clockInAt. */
  entries: LaborEntry[];
  byEntry: Map<LaborEntry, EntryHours>;
  byPerson: Map<string, HoursSplit>;
  /** The span loaded, [from, to) — `from` is a company week start. */
  from: Date;
  to: Date;
}

/**
 * Every approved/completed punch in [weekStart(from), to), split once per
 * person the way the paycheck splits it. Starting on a week boundary keeps
 * the first week's overtime where pay puts it.
 */
export async function loadLaborBook(db: Db, tenantId: string, from: Date, to: Date): Promise<LaborBook> {
  const start = startOfWeekUTC(from);
  const raw = await db.timeEntry.findMany({
    where: { tenantId, status: { in: ['APPROVED', 'COMPLETED'] }, clockInAt: { gte: start, lt: to } },
    select: {
      associateId: true,
      clientId: true,
      locationId: true,
      clockInAt: true,
      clockOutAt: true,
      breaks: { select: { startedAt: true, endedAt: true } },
      location: { select: { id: true, state: true, city: true, timezone: true } },
    },
    orderBy: { clockInAt: 'asc' },
    take: 250_000,
  });
  const entries: LaborEntry[] = raw.map(({ location, ...e }) => ({ ...e, site: location }));
  const split = splitByPerson(await loadLiveRules(db as PrismaClient, tenantId), entries);
  return { entries, byEntry: split.byEntry, byPerson: split.byPerson, from: start, to };
}

export interface LaborTotals {
  /** Paid hours: approved/completed time, breaks out, as pay splits it. */
  hours: number;
  /** Overtime plus double time. */
  otHours: number;
  dtHours: number;
  heads: number;
  billed: number;
  /** Every paid hour at the straight pay rate. */
  basePay: number;
  /** What the overtime and double-time multipliers add on the pay side. */
  otPremium: number;
  pay: number;
  burden: number;
  overhead: number;
  cost: number;
  margin: number;
}

const zeroTotals = (): LaborTotals => ({ hours: 0, otHours: 0, dtHours: 0, heads: 0, billed: 0, basePay: 0, otPremium: 0, pay: 0, burden: 0, overhead: 0, cost: 0, margin: 0 });

function addShare(t: LaborTotals, share: EntryHours, m: HoursSplit, rates: ExecRates): void {
  const pay = payFor(share, rates.payRate, m);
  const billed = payFor(share, rates.billRate, m);
  const burden = pay * (rates.burdenPct / 100);
  const overhead = share.workedHours * rates.overheadPerHour;
  t.hours += share.workedHours;
  t.otHours += share.overtimeHours + share.doubleTimeHours;
  t.dtHours += share.doubleTimeHours;
  t.billed += billed;
  t.basePay += share.workedHours * rates.payRate;
  t.pay += pay;
  t.burden += burden;
  t.overhead += overhead;
  t.cost += pay + burden + overhead;
}

function finish(t: LaborTotals, heads: Set<string>): LaborTotals {
  t.heads = heads.size;
  t.otPremium = t.pay - t.basePay;
  t.margin = t.billed - t.cost;
  return t;
}

/** First index whose clockInAt is at or after `at`. */
function lowerBound(entries: LaborEntry[], at: Date): number {
  let lo = 0;
  let hi = entries.length;
  const t = at.getTime();
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.clockInAt.getTime() < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The labor in [from, to) — the summary's aggregateWeek, unrounded, with the cost walk beside it. */
export function laborBetween(book: LaborBook, from: Date, to: Date, rates: ExecRates = execRates(), keep?: (e: LaborEntry) => boolean): LaborTotals {
  const t = zeroTotals();
  const heads = new Set<string>();
  for (let i = lowerBound(book.entries, from); i < book.entries.length; i++) {
    const e = book.entries[i]!;
    if (e.clockInAt >= to) break;
    if (keep && !keep(e)) continue;
    const share = book.byEntry.get(e);
    if (!share || share.workedHours <= 0) continue;
    heads.add(e.associateId);
    addShare(t, share, book.byPerson.get(e.associateId)!, rates);
  }
  return finish(t, heads);
}

/** Whether a book covers a span (the span lies inside what was loaded). */
export const covers = (book: LaborBook, from: Date, to: Date) => from >= book.from && to <= book.to;

/* ------------------------------------------------------------------- plan */

export interface QuarterPlan {
  revenue: number | null;
  margin: number | null;
  headcount: number | null;
  turnoverPct: number | null;
  fillRatePct: number | null;
}

/** The plan rows for these quarter keys ("2026-Q4"), this tenant's. */
export async function loadPlan(db: Db, tenantId: string, quarterKeys: string[]): Promise<Map<string, QuarterPlan>> {
  const rows = await db.execTarget.findMany({ where: { tenantId, quarter: { in: [...new Set(quarterKeys)] } } });
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return new Map(
    rows.map((r) => [
      r.quarter,
      { revenue: n(r.revenueTarget), margin: n(r.marginTarget), headcount: r.headcountTarget, turnoverPct: n(r.turnoverPctTarget), fillRatePct: n(r.fillRatePctTarget) },
    ]),
  );
}

export function planIsSet(plan: Map<string, QuarterPlan>, quarterKeys: string[]): boolean {
  return quarterKeys.some((k) => {
    const p = plan.get(k);
    return !!p && Object.values(p).some((v) => v !== null);
  });
}

/* --------------------------------------------------------------------- AR */

export interface ArStatement {
  id: string;
  clientId: string;
  clientName: string;
  number: number | null;
  periodEnd: Date;
  finalizedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  /** Dollars. */
  total: number;
}

export interface ArBook {
  statements: ArStatement[];
  /** Payments applied, by statement (not voided): amount in dollars, the day it was received. */
  applied: Map<string, Array<{ amount: number; receivedOn: Date }>>;
}

/** Every finalized statement and the payments applied to it, this tenant's. */
export async function loadArBook(db: Db, tenantId: string): Promise<ArBook> {
  const rows = await db.clientStatement.findMany({
    where: { tenantId, status: 'FINAL' },
    select: { id: true, clientId: true, number: true, periodEnd: true, finalizedAt: true, dueAt: true, paidAt: true, snapshot: true, client: { select: { name: true } } },
    orderBy: { finalizedAt: 'asc' },
    take: 20_000,
  });
  const apps = rows.length
    ? await db.clientPaymentApplication.findMany({
        where: { tenantId, statementId: { in: rows.map((r) => r.id) }, payment: { voidedAt: null } },
        select: { statementId: true, amount: true, payment: { select: { receivedOn: true } } },
      })
    : [];
  const applied = new Map<string, Array<{ amount: number; receivedOn: Date }>>();
  for (const a of apps) {
    const list = applied.get(a.statementId) ?? [];
    list.push({ amount: Number(a.amount), receivedOn: a.payment.receivedOn });
    applied.set(a.statementId, list);
  }
  return {
    statements: rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      clientName: r.client.name,
      number: r.number,
      periodEnd: r.periodEnd,
      finalizedAt: r.finalizedAt,
      dueAt: r.dueAt,
      paidAt: r.paidAt,
      total: statementAmounts(r.snapshot).total / 100,
    })),
    applied,
  };
}

/**
 * What clients owed at an instant: each statement finalized by then and not
 * marked paid by then, less the payments received by then. At "now" this is
 * the receivables view's open AR (routes/executive /receivables).
 */
export function arAsOf(book: ArBook, at: Date): Array<ArStatement & { open: number }> {
  const out: Array<ArStatement & { open: number }> = [];
  for (const s of book.statements) {
    if (!s.finalizedAt || s.finalizedAt > at) continue;
    if (s.paidAt && s.paidAt <= at) continue;
    const got = (book.applied.get(s.id) ?? []).filter((p) => p.receivedOn <= at).reduce((n, p) => n + p.amount, 0);
    const open = Math.max(0, r2(s.total - got));
    if (open > 0) out.push({ ...s, open });
  }
  return out;
}

/** Statements finalized in [from, to), dollars. */
export function finalizedBetween(book: ArBook, from: Date, to: Date): number {
  return book.statements.reduce((n, s) => (s.finalizedAt && s.finalizedAt >= from && s.finalizedAt < to ? n + s.total : n), 0);
}

/** Days sales outstanding at an instant: open AR ÷ (the last 90 days' finalized statements ÷ 90). Null when nothing was billed. */
export function dsoAsOf(book: ArBook, at: Date): number | null {
  const billed90 = finalizedBetween(book, new Date(at.getTime() - 90 * DAY_MS), at);
  if (billed90 <= 0) return null;
  const ar = arAsOf(book, at).reduce((n, s) => n + s.open, 0);
  return ar / (billed90 / 90);
}

/** The aging of what is open now (lib/books/aging), oldest-and-largest first. */
export function agingNow(book: ArBook, now: Date) {
  const open = arAsOf(book, now);
  const aged = ageStatements(open.map((s) => ({ ...s, amount: s.open })), now);
  const statements = aged.statements
    .map(({ row, daysPastDue, dueOn }) => ({ row, ageDays: daysPastDue, dueOn }))
    .sort((a, b) => b.ageDays - a.ageDays || b.row.amount - a.row.amount);
  return { total: aged.total, buckets: aged.buckets, statements };
}

/* ------------------------------------------------------------------- cash */

/**
 * The books' bank balance at the end of each day given (YYYY-MM-DD, the
 * day's posted entries included): active BANK accounts, debit − credit —
 * the money band's "cash today". Null when the books hold no bank account.
 */
export async function bankBalances(db: Db, tenantId: string, days: string[]): Promise<{ accounts: number; byDay: Map<string, number> } | null> {
  const accounts = await db.ledgerAccount.findMany({ where: { tenantId, isActive: true, subtype: 'BANK' }, select: { id: true } });
  if (accounts.length === 0) return null;
  const ids = accounts.map((a) => a.id);
  const sorted = [...new Set(days)].sort();
  const byDay = new Map<string, number>();
  if (sorted.length === 0) return { accounts: accounts.length, byDay };
  const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const [opening, lines] = await Promise.all([
    db.journalLine.aggregate({ where: { tenantId, accountId: { in: ids }, entry: { status: 'POSTED', entryDate: { lte: day(first) } } }, _sum: { debit: true, credit: true } }),
    first === last
      ? Promise.resolve([] as Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal; entry: { entryDate: Date } }>)
      : db.journalLine.findMany({
          where: { tenantId, accountId: { in: ids }, entry: { status: 'POSTED', entryDate: { gt: day(first), lte: day(last) } } },
          select: { debit: true, credit: true, entry: { select: { entryDate: true } } },
          take: 200_000,
        }),
  ]);
  const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
  let bal = cents(opening._sum.debit) - cents(opening._sum.credit);
  const moves = lines
    .map((l) => ({ day: l.entry.entryDate.toISOString().slice(0, 10), net: cents(l.debit) - cents(l.credit) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let i = 0;
  for (const d of sorted) {
    // Lines after the first day only: the opening already holds it.
    while (i < moves.length && moves[i]!.day <= d) bal += moves[i++]!.net;
    byDay.set(d, bal / 100);
  }
  return { accounts: accounts.length, byDay };
}

/* ----------------------------------------------------------------- active */

/**
 * The active headcount at several instants with one placement reading —
 * lib/activeDefinition's rule exactly (placed now; a non-rejected punch in
 * the window before the instant, or an assigned shift starting at or after
 * it). At "now" this is activeHeadcount().
 */
export async function activeCountsAt(db: Db, tenantId: string, instants: Date[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (instants.length === 0) return out;
  const [windowDays, placed] = await Promise.all([activeWindowDays(db), placements({ tenantId }, db)]);
  if (placed.size === 0) {
    for (const at of instants) out.set(at.getTime(), 0);
    return out;
  }
  const earliest = new Date(Math.min(...instants.map((d) => d.getTime())));
  const shifts = await db.shift.findMany({
    where: { tenantId, status: 'ASSIGNED', startsAt: { gte: earliest }, assignedAssociateId: { not: null } },
    select: { assignedAssociateId: true, startsAt: true },
  });
  const unique = [...new Map(instants.map((d) => [d.getTime(), d])).values()];
  const worked = await Promise.all(
    unique.map((at) =>
      db.timeEntry.findMany({
        where: { tenantId, clockInAt: { gte: new Date(at.getTime() - windowDays * DAY_MS), lte: at }, status: { not: 'REJECTED' } },
        select: { associateId: true },
        distinct: ['associateId'],
      }),
    ),
  );
  unique.forEach((at, i) => {
    const ids = new Set<string>();
    for (const w of worked[i]!) if (placed.has(w.associateId)) ids.add(w.associateId);
    for (const s of shifts) if (s.startsAt >= at && s.assignedAssociateId && placed.has(s.assignedAssociateId)) ids.add(s.assignedAssociateId);
    out.set(at.getTime(), ids.size);
  });
  return out;
}

/* ------------------------------------------------------------------ shifts */

/** Published shifts starting in [from, to) and how many have someone assigned — the targets card's fill rule. */
export async function fillCounts(db: Db, tenantId: string, from: Date, to: Date): Promise<{ published: number; assigned: number }> {
  const where = { tenantId, publishedAt: { not: null }, status: { notIn: ['CANCELLED', 'DRAFT'] as Array<'CANCELLED' | 'DRAFT'> }, startsAt: { gte: from, lt: to } };
  const [published, assigned] = await Promise.all([db.shift.count({ where }), db.shift.count({ where: { ...where, assignedAssociateId: { not: null } } })]);
  return { published, assigned };
}

/** The same rule per week, one query: fill % for each [bounds[i], bounds[i+1]). */
export async function weeklyFill(db: Db, tenantId: string, bounds: Date[]): Promise<Array<number | null>> {
  if (bounds.length < 2) return [];
  const rows = await db.shift.findMany({
    where: { tenantId, publishedAt: { not: null }, status: { notIn: ['CANCELLED', 'DRAFT'] }, startsAt: { gte: bounds[0]!, lt: bounds[bounds.length - 1]! } },
    select: { startsAt: true, assignedAssociateId: true },
  });
  const pub = new Array<number>(bounds.length - 1).fill(0);
  const asg = new Array<number>(bounds.length - 1).fill(0);
  for (const r of rows) {
    for (let i = 0; i < bounds.length - 1; i++) {
      if (r.startsAt >= bounds[i]! && r.startsAt < bounds[i + 1]!) {
        pub[i]! += 1;
        if (r.assignedAssociateId) asg[i]! += 1;
        break;
      }
    }
  }
  return pub.map((p, i) => (p > 0 ? (asg[i]! / p) * 100 : null));
}

/* ------------------------------------------------------------------- days */

/** The company calendar day an instant falls on. */
export const dayKey = (d: Date, tz: string) => localDateKey(d, tz);
/** The last calendar day of a [from, to) span. */
export const lastDayKey = (to: Date, tz: string) => localDateKey(new Date(to.getTime() - 1), tz);
