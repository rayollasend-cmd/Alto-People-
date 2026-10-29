import { Prisma, type PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { payFor, splitByPerson, type EntryHours, type HoursSplit, type LaborSite } from './laborRules/hours.js';
import { loadLiveRules, type LiveRules } from './laborRules/live.js';
import { startOfWeekUTC } from './timeAnomalies.js';

/**
 * PAID HOURS — the one definition of "hours worked" on the executive
 * portal and Analytics (2026-10-27).
 *
 *   approved or completed punches that are closed, every break out, and
 *   each person's workweek split by the labor-rules engine exactly as pay
 *   splits it (the federal weekly 40, or a live jurisdiction's daily and
 *   double-time rules, its short paid breaks included). A punch belongs to
 *   the week its clock-in falls in; a week's total is rounded to the
 *   hundredth of an hour, as the paycheck rounds hours.
 *
 * This is the executive summary's math (lib/executiveSummary aggregateWeek
 * and priceShare) and the executive portal's labor book (lib/execFinance),
 * held here for the pages that read it outside that book — the Clients and
 * People drill-downs and Analytics' "Hours worked" — so every surface reads
 * the same number for the same week. Before it, Analytics summed raw
 * clock-in to clock-out of every closed punch — rejected time and breaks
 * included — and read 1,136 h for a week the executive home called 1,065.1 h.
 *
 * Punch-rounding policies (lib/punchRounding) are not applied here, as they
 * are not in the summary or the labor book: the three move together.
 *
 * Dollar figures are ESTIMATES at the org standard rates (env pay/bill
 * defaults, labor burden and overhead per hour), billed and paid at the
 * engine's multipliers — the labor board's convention.
 */

export type Db = PrismaClient | Prisma.TransactionClient;

export interface PaidEntry {
  id: string;
  associateId: string;
  clientId: string | null;
  locationId: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: Array<{ startedAt: Date; endedAt: Date | null }>;
  site: LaborSite | null;
}

/** One counted punch and its share of its person's split. */
export interface PaidShare {
  entry: PaidEntry;
  /** Paid hours on this punch. */
  hours: number;
  /** Overtime + double time among them. */
  otHours: number;
  doubleTimeHours: number;
  /** What the multipliers add, in straight-time hours (½ h per OT hour at 1.5×). */
  premiumHours: number;
  /** Est. billed and est. labor cost (burdened, with overhead) at the standard rates. */
  billed: number;
  cost: number;
}

export interface PaidHoursQuery {
  tenantId: string;
  /** Count punches clocked in from here… */
  from: Date;
  /** …to here (exclusive). */
  to: Date;
  /** Narrow the punches read (a client clamp, a caller's sites). The split then sees only these. */
  where?: Prisma.TimeEntryWhereInput;
  /** The tenant's live rules, when the caller already loaded them. */
  rules?: LiveRules;
}

/** Hours to the hundredth, as the summary rounds a week. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Est. billed and est. labor cost for a share of hours, at the standard rates and the split's multipliers. */
export function priceShare(share: Pick<EntryHours, 'workedHours' | 'regularHours' | 'overtimeHours' | 'doubleTimeHours'>, m: HoursSplit): { billed: number; cost: number } {
  const burden = 1 + env.LABOR_BURDEN_PERCENT / 100;
  return {
    billed: payFor(share, env.DEFAULT_ASSOCIATE_BILL_RATE, m),
    cost: payFor(share, env.DEFAULT_ASSOCIATE_PAY_RATE, m) * burden + share.workedHours * env.LABOR_OVERHEAD_PER_HOUR,
  };
}

/** The rate assumptions behind every est. figure. */
export function standardRates(): { billRate: number; payRate: number; burdenPct: number; overheadPerHour: number } {
  return {
    billRate: env.DEFAULT_ASSOCIATE_BILL_RATE,
    payRate: env.DEFAULT_ASSOCIATE_PAY_RATE,
    burdenPct: env.LABOR_BURDEN_PERCENT,
    overheadPerHour: env.LABOR_OVERHEAD_PER_HOUR,
  };
}

/**
 * Every paid punch clocked in during [from, to), each with its share. The
 * read starts at the company week containing `from`, so the first week's
 * overtime splits over the whole week as the paycheck splits it; punches
 * before `from` shape the split and are not returned.
 */
export async function loadPaidHours(db: Db, q: PaidHoursQuery): Promise<PaidShare[]> {
  if (q.to <= q.from) return [];
  const readFrom = startOfWeekUTC(q.from);
  const [rows, rules] = await Promise.all([
    db.timeEntry.findMany({
      where: {
        AND: [
          { tenantId: q.tenantId, status: { in: ['APPROVED', 'COMPLETED'] }, clockOutAt: { not: null }, clockInAt: { gte: readFrom, lt: q.to } },
          ...(q.where ? [q.where] : []),
        ],
      },
      select: {
        id: true,
        associateId: true,
        clientId: true,
        locationId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
        location: { select: { id: true, state: true, city: true, timezone: true } },
      },
      take: 250_000,
    }),
    q.rules ? Promise.resolve(q.rules) : loadLiveRules(db, q.tenantId),
  ]);
  const entries: PaidEntry[] = rows.map(({ location, ...e }) => ({ ...e, site: location }));
  const split = splitByPerson(rules, entries);
  const out: PaidShare[] = [];
  for (const e of entries) {
    if (e.clockInAt < q.from || e.clockInAt >= q.to) continue;
    const share = split.byEntry.get(e);
    if (!share || share.workedHours <= 0) continue;
    const m = split.byPerson.get(e.associateId)!;
    const p = priceShare(share, m);
    out.push({
      entry: e,
      hours: share.workedHours,
      otHours: share.overtimeHours + share.doubleTimeHours,
      doubleTimeHours: share.doubleTimeHours,
      premiumHours: share.overtimeHours * (m.overtimeMultiplier - 1) + share.doubleTimeHours * (m.doubleMultiplier - 1),
      billed: p.billed,
      cost: p.cost,
    });
  }
  return out;
}

export interface PaidTotals {
  hours: number;
  otHours: number;
  billed: number;
  cost: number;
  margin: number;
  /** Distinct people with paid time. */
  heads: number;
}

/** Totals of the shares clocked in during [from, to) (all of them when no bounds), rounded as the summary rounds them. */
export function totalPaid(shares: readonly PaidShare[], from?: Date, to?: Date, keep?: (s: PaidShare) => boolean): PaidTotals {
  let hours = 0;
  let ot = 0;
  let billed = 0;
  let cost = 0;
  const heads = new Set<string>();
  for (const s of shares) {
    if (from && s.entry.clockInAt < from) continue;
    if (to && s.entry.clockInAt >= to) continue;
    if (keep && !keep(s)) continue;
    hours += s.hours;
    ot += s.otHours;
    billed += s.billed;
    cost += s.cost;
    heads.add(s.entry.associateId);
  }
  return { hours: round2(hours), otHours: round2(ot), billed: round2(billed), cost: round2(cost), margin: round2(billed - cost), heads: heads.size };
}

/** Paid hours per week for consecutive week starts (the last bucket ends at `end`), unrounded sums rounded once. */
export function weeklyPaidHours(shares: readonly PaidShare[], weekStarts: readonly Date[], end: Date): number[] {
  const sums = new Array<number>(weekStarts.length).fill(0);
  for (const s of shares) {
    const t = s.entry.clockInAt.getTime();
    if (t >= end.getTime()) continue;
    for (let i = weekStarts.length - 1; i >= 0; i--) {
      if (t >= weekStarts[i]!.getTime()) {
        sums[i] += s.hours;
        break;
      }
    }
  }
  return sums.map(round2);
}

/** The consecutive company week starts ending with the one containing `now`, oldest first (`n` of them). */
export function weekStartsEndingWith(now: Date, n: number): Date[] {
  const starts = [startOfWeekUTC(now)];
  // 36 h back from a boundary lands inside the previous week whatever DST did.
  while (starts.length < n) starts.unshift(startOfWeekUTC(new Date(starts[0]!.getTime() - 36 * 3_600_000)));
  return starts;
}

export interface WeeklyPaidQuery {
  tenantId: string;
  /** Consecutive week starts, oldest first; the last bucket runs to `end`. */
  weekStarts: Date[];
  end: Date;
  /** Only this client's punches (a client-bound caller). */
  clientId?: string | null;
  /** Only punches at these sites (a site-bound caller). */
  siteIds?: string[] | null;
}

/**
 * Paid hours per week — Analytics' "Hours worked" line. Exactly
 * `weeklyPaidHours(loadPaidHours(…))`; when no jurisdiction is live (every
 * break docked — today's pay for most tenants) a punch's paid hours do not
 * depend on the rest of its week, so the same sum runs in SQL and the home dashboard
 * never pulls eight weeks of punches through the app to draw one line. The
 * two paths are held equal by a test (__tests__/lib/paidHours).
 */
export async function paidHoursByWeek(db: Db, q: WeeklyPaidQuery): Promise<number[]> {
  if (q.weekStarts.length === 0) return [];
  const rules = await loadLiveRules(db, q.tenantId);
  if (!rules.any) return paidHoursByWeekSql(db, q);
  const shares = await loadPaidHours(db, {
    tenantId: q.tenantId,
    rules,
    from: q.weekStarts[0]!,
    to: q.end,
    where: {
      AND: [
        ...(q.clientId ? [{ clientId: q.clientId }] : []),
        ...(q.siteIds ? [{ locationId: { in: q.siteIds } }] : []),
      ],
    },
  });
  return weeklyPaidHours(shares, q.weekStarts, q.end);
}

/** The SQL path: each closed approved/completed punch's span less every break (open breaks run to the clock-out), floored at zero. */
export async function paidHoursByWeekSql(db: Db, q: WeeklyPaidQuery): Promise<number[]> {
  const starts = q.weekStarts.map((d) => d.toISOString());
  const ends = q.weekStarts.map((_, i) => (q.weekStarts[i + 1] ?? q.end).toISOString());
  const rows = await db.$queryRaw<Array<{ wk: number; hours: number }>>(Prisma.sql`
    SELECT w.i::int AS wk,
      COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (t."clockOutAt" - t."clockInAt")) - COALESCE(b.secs, 0))), 0)::float8 / 3600 AS hours
    FROM unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) WITH ORDINALITY AS w(s, e, i)
    JOIN "TimeEntry" t ON t."clockInAt" >= w.s AND t."clockInAt" < w.e
    LEFT JOIN LATERAL (
      SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(be."endedAt", t."clockOutAt") - be."startedAt")))) AS secs
      FROM "BreakEntry" be
      WHERE be."timeEntryId" = t."id"
    ) b ON true
    WHERE t."tenantId" = ${q.tenantId}::uuid
      AND t."status" IN ('APPROVED'::"TimeEntryStatus", 'COMPLETED'::"TimeEntryStatus")
      AND t."clockOutAt" > t."clockInAt"
      ${q.clientId ? Prisma.sql`AND t."clientId" = ${q.clientId}::uuid` : Prisma.empty}
      ${q.siteIds ? Prisma.sql`AND t."locationId" = ANY(${q.siteIds}::uuid[])` : Prisma.empty}
    GROUP BY w.i
  `);
  const out = new Array<number>(q.weekStarts.length).fill(0);
  for (const r of rows) {
    const i = Number(r.wk) - 1;
    if (i >= 0 && i < out.length) out[i] = round2(Number(r.hours));
  }
  return out;
}
