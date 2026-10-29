import type { Prisma, PrismaClient } from '@prisma/client';
import {
  RELIABILITY_ERROR_BUDGET,
  type ReliabilityDayPoint,
  type ReliabilityResponse,
  type ReliabilityRouteRow,
  type ReliabilityWeekRow,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { endOfWeekUTC, startOfWeekUTC } from './timeAnomalies.js';
import { addLatencyHistograms, emptyLatencyHistogram, percentileFromLatencyHistogram } from './usageTracker.js';
import { sentryHourlyErrorCounts, sentryOpenIssues, sentryReadConfig } from './sentryApi.js';

/**
 * IS THE PLATFORM STAYING UP, AND WHERE IS IT SLOW?
 *
 * Brief 1B-3's four measures, computed from what the API already keeps:
 *
 *   weekly errors        Sentry, when a read token is configured (the
 *                        budget is "under ten a week"; a 5xx count from
 *                        our own rollup rides alongside and is never null)
 *   p95 by route         the latency histogram on RouteUsageDaily
 *   kiosk punch success  KioskPunch rows — REJECTED is the failure action
 *   ride completion      Ride rows past their pickup time
 *
 * Plus restarts from ApiBoot, because the OOM-kill era is the reason the
 * reliability score is a five.
 *
 * Weeks are org weeks (Saturday 00:00 Florida-local), the same ones
 * payroll and the executive digest use, so "last week's errors" means
 * the same thing on every surface.
 */

type Db = Pick<PrismaClient, 'routeUsageDaily' | 'kioskPunch' | 'ride' | 'apiBoot' | 'reliabilityWeek' | '$queryRaw'>;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const WEEKS_SHOWN = 8;
/** A p95 over fewer requests than this is noise, not a slow route. */
const MIN_REQUESTS_FOR_SLOWEST = 20;

/**
 * Connections held open on purpose — the per-user event stream lives for
 * as long as the tab does — so their "latency" is the length of a visit,
 * not a slow answer. They stay in the request and error totals, and out
 * of every speed ranking.
 */
const LONG_LIVED_ROUTES = new Set(['GET /events/stream']);
export const isLongLivedRoute = (method: string, route: string): boolean => LONG_LIVED_ROUTES.has(`${method} ${route}`);
const timed = (r: { method: string; route: string }) => !isLongLivedRoute(r.method, r.route);

// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: RouteUsageDaily rolls up per UTC day (usageTracker.dayKey) and the kiosk series groups by UTC day in SQL; these windows must line up with those rows.
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

/** UTC midnight `days` ago, inclusive of today. */
function windowStart(days: number, now: Date): Date {
  return new Date(utcDay(dayKey(now)).getTime() - (days - 1) * ONE_DAY_MS);
}

function shapeRoute(r: {
  method: string;
  route: string;
  ok: number;
  clientError: number;
  serverError: number;
  totalMs: bigint | number;
  histogram: number[];
}): ReliabilityRouteRow {
  const requests = r.ok + r.clientError + r.serverError;
  return {
    method: r.method,
    route: r.route,
    requests,
    serverError: r.serverError,
    avgMs: requests > 0 ? Math.round(Number(r.totalMs) / requests) : 0,
    p95Ms: percentileFromLatencyHistogram(r.histogram, 0.95),
  };
}

/**
 * Route rows between two UTC days (inclusive start, exclusive end), folded
 * per route. groupBy can't sum an array column, so the fold is in memory;
 * a window is at most a few thousand rows.
 */
async function routeTotals(db: Db, from: Date, to: Date) {
  const rows = await db.routeUsageDaily.findMany({
    where: { day: { gte: from, lt: to } },
    select: { method: true, route: true, ok: true, clientError: true, serverError: true, totalMs: true, histogram: true },
  });
  const byRoute = new Map<
    string,
    { method: string; route: string; ok: number; clientError: number; serverError: number; totalMs: number; histogram: number[] }
  >();
  for (const r of rows) {
    const key = `${r.method} ${r.route}`;
    let b = byRoute.get(key);
    if (!b) {
      b = { method: r.method, route: r.route, ok: 0, clientError: 0, serverError: 0, totalMs: 0, histogram: emptyLatencyHistogram() };
      byRoute.set(key, b);
    }
    b.ok += r.ok;
    b.clientError += r.clientError;
    b.serverError += r.serverError;
    b.totalMs += Number(r.totalMs);
    b.histogram = addLatencyHistograms(b.histogram, r.histogram);
  }
  return [...byRoute.values()].map(shapeRoute);
}

export interface WeekFacts {
  weekStart: Date;
  weekEnd: Date;
  serverErrors: number;
  requests: number;
  busiest: ReliabilityRouteRow[];
  punchTotal: number;
  punchAccepted: number;
  rideTotal: number;
  rideCompleted: number;
  rideNoShow: number;
  rideUnresolved: number;
  restarts: number;
}

async function kioskCounts(db: Db, from: Date, to: Date): Promise<{ total: number; accepted: number }> {
  const [total, rejected] = await Promise.all([
    db.kioskPunch.count({ where: { createdAt: { gte: from, lt: to } } }),
    db.kioskPunch.count({ where: { createdAt: { gte: from, lt: to }, action: 'REJECTED' } }),
  ]);
  return { total, accepted: total - rejected };
}

/**
 * Seats whose pickup time has passed. Cancellations are the rider's
 * choice, not a service failure, so they are out; a seat still REQUESTED
 * or SCHEDULED after its time is a ride nobody closed — counted against
 * completion, because from the rider's side it did not happen.
 */
async function rideCounts(db: Db, from: Date, to: Date, now: Date) {
  const cutoff = to < now ? to : now;
  const where: Prisma.RideWhereInput = {
    targetAt: { gte: from, lt: cutoff },
    status: { not: 'CANCELLED' },
  };
  const grouped = await db.ride.groupBy({ by: ['status'], where, _count: { _all: true } });
  const n = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const completed = n('COMPLETED');
  const noShow = n('NO_SHOW');
  const total = grouped.reduce((s, g) => s + g._count._all, 0);
  return { total, completed, noShow, unresolved: total - completed - noShow };
}

/** Everything the digest snapshots for one org week, closed or in progress. */
export async function computeWeekFacts(db: Db, weekStart: Date, now: Date): Promise<WeekFacts> {
  const weekEnd = new Date(weekStart.getTime() + 7 * ONE_DAY_MS);
  // The rollup is per UTC day; the org week starts a few hours into a UTC
  // day. Days are taken whole, which puts the Friday-night hours in the
  // following week's traffic — a few hours of a 168-hour week.
  const dayFrom = utcDay(dayKey(weekStart));
  const dayTo = utcDay(dayKey(weekEnd));
  const [routes, punches, rides, restarts] = await Promise.all([
    routeTotals(db, dayFrom, dayTo),
    kioskCounts(db, weekStart, weekEnd),
    rideCounts(db, weekStart, weekEnd, now),
    db.apiBoot.count({ where: { bootAt: { gte: weekStart, lt: weekEnd } } }),
  ]);
  return {
    weekStart,
    weekEnd,
    serverErrors: routes.reduce((s, r) => s + r.serverError, 0),
    requests: routes.reduce((s, r) => s + r.requests, 0),
    busiest: routes.filter(timed).sort((a, b) => b.requests - a.requests).slice(0, 10),
    punchTotal: punches.total,
    punchAccepted: punches.accepted,
    rideTotal: rides.total,
    rideCompleted: rides.completed,
    rideNoShow: rides.noShow,
    rideUnresolved: rides.unresolved,
    restarts,
  };
}

/** Sentry's error count for each week, folded from hourly buckets. Null per week when unavailable. */
async function sentryByWeek(weeks: Array<{ weekStart: Date; weekEnd: Date }>): Promise<Array<number | null>> {
  if (weeks.length === 0) return [];
  const hourly = await sentryHourlyErrorCounts(weeks[0]!.weekStart, weeks[weeks.length - 1]!.weekEnd);
  if (!hourly) return weeks.map(() => null);
  return weeks.map((w) => {
    let sum = 0;
    for (const h of hourly) {
      const at = new Date(h.at).getTime();
      if (at >= w.weekStart.getTime() && at < w.weekEnd.getTime()) sum += h.errors;
    }
    return sum;
  });
}

/**
 * The last WEEKS_SHOWN org weeks, oldest first, the week in progress last.
 * Sentry's live number wins; a snapshot the digest wrote fills a week
 * Sentry no longer holds; otherwise null.
 */
export async function reliabilityWeeks(db: Db, now: Date): Promise<ReliabilityWeekRow[]> {
  const thisStart = startOfWeekUTC(now);
  const starts: Date[] = [];
  for (let i = WEEKS_SHOWN - 1; i >= 0; i--) {
    // Step back by whole weeks from the current start, then re-anchor so a
    // DST change inside the span lands on the real local midnight.
    starts.push(startOfWeekUTC(new Date(thisStart.getTime() - i * 7 * ONE_DAY_MS + 12 * 3_600_000)));
  }
  const spans = starts.map((weekStart) => ({ weekStart, weekEnd: endOfWeekUTC(new Date(weekStart.getTime() + 12 * 3_600_000)) }));
  const [live, snapshots, facts] = await Promise.all([
    sentryByWeek(spans),
    db.reliabilityWeek.findMany({
      where: { weekStart: { in: starts } },
      select: { weekStart: true, sentryErrors: true, serverErrors: true, requests: true },
    }),
    Promise.all(spans.map((s) => computeWeekFacts(db, s.weekStart, now))),
  ]);
  const snap = new Map(snapshots.map((s) => [s.weekStart.getTime(), s]));
  return spans.map((s, i) => {
    const current = s.weekStart.getTime() === thisStart.getTime();
    const sentryErrors = live[i] ?? snap.get(s.weekStart.getTime())?.sentryErrors ?? null;
    return {
      weekStart: s.weekStart.toISOString(),
      weekEnd: s.weekEnd.toISOString(),
      sentryErrors,
      serverErrors: facts[i]!.serverErrors,
      requests: facts[i]!.requests,
      underBudget: current || sentryErrors === null ? null : sentryErrors <= RELIABILITY_ERROR_BUDGET,
      current,
    };
  });
}

/** Closed weeks at or under budget, counted back from the most recent closed week. */
export function consecutiveWeeksUnderBudget(weeks: readonly ReliabilityWeekRow[]): number | null {
  const closed = weeks.filter((w) => !w.current);
  if (closed.every((w) => w.sentryErrors === null)) return null;
  let n = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (closed[i]!.underBudget !== true) break;
    n += 1;
  }
  return n;
}

async function kioskSeries(db: Db, from: Date, now: Date): Promise<ReliabilityDayPoint[]> {
  const rows = await db.$queryRaw<Array<{ day: Date; total: bigint; accepted: bigint }>>`
    SELECT date_trunc('day', "createdAt" AT TIME ZONE 'UTC') AS day,
           count(*)::bigint AS total,
           count(*) FILTER (WHERE "action" <> 'REJECTED')::bigint AS accepted
    FROM "KioskPunch"
    WHERE "createdAt" >= ${from}
    GROUP BY 1`;
  const byDay = new Map(rows.map((r) => [dayKey(new Date(r.day)), { total: Number(r.total), accepted: Number(r.accepted) }]));
  const out: ReliabilityDayPoint[] = [];
  for (let t = from.getTime(); t <= now.getTime(); t += ONE_DAY_MS) {
    const day = dayKey(new Date(t));
    const v = byDay.get(day);
    out.push({ day, total: v?.total ?? 0, accepted: v?.accepted ?? 0 });
  }
  return out;
}

export async function computeReliability(
  days: number,
  now: Date = new Date(),
  db: Db = defaultPrisma,
): Promise<ReliabilityResponse> {
  const from = windowStart(days, now);
  const tomorrow = new Date(utcDay(dayKey(now)).getTime() + ONE_DAY_MS);
  const [routes, punches, series, rides, restartCount, lastBoot, weeks, issues] = await Promise.all([
    routeTotals(db, from, tomorrow),
    kioskCounts(db, from, tomorrow),
    kioskSeries(db, from, now),
    rideCounts(db, from, tomorrow, now),
    db.apiBoot.count({ where: { bootAt: { gte: from } } }),
    db.apiBoot.findFirst({ orderBy: { bootAt: 'desc' }, select: { bootAt: true, version: true } }),
    reliabilityWeeks(db, now),
    sentryOpenIssues(days),
  ]);
  const thisWeek = weeks[weeks.length - 1];
  return {
    days,
    budget: RELIABILITY_ERROR_BUDGET,
    sentry: {
      configured: sentryReadConfig() !== null,
      issues: (issues ?? []).map((i) => ({
        shortId: i.shortId,
        title: i.title,
        culprit: i.culprit,
        count: i.count,
        userCount: i.userCount,
        lastSeen: i.lastSeen,
        permalink: i.permalink,
        project: i.project,
      })),
    },
    errors: {
      thisWeek: thisWeek?.sentryErrors ?? null,
      serverErrorsThisWeek: thisWeek?.serverErrors ?? 0,
      weeks,
      consecutiveWeeksUnderBudget: consecutiveWeeksUnderBudget(weeks),
    },
    routes: {
      busiest: routes.filter(timed).sort((a, b) => b.requests - a.requests).slice(0, 10),
      slowest: routes
        .filter((r) => timed(r) && r.requests >= MIN_REQUESTS_FOR_SLOWEST && r.p95Ms !== null)
        .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
        .slice(0, 5),
    },
    kiosk: {
      total: punches.total,
      accepted: punches.accepted,
      rejected: punches.total - punches.accepted,
      rate: punches.total > 0 ? punches.accepted / punches.total : null,
      series,
    },
    rides: {
      total: rides.total,
      completed: rides.completed,
      noShow: rides.noShow,
      unresolved: rides.unresolved,
      rate: rides.total > 0 ? rides.completed / rides.total : null,
    },
    restarts: {
      count: restartCount,
      lastBootAt: lastBoot?.bootAt.toISOString() ?? null,
      version: lastBoot?.version ?? null,
    },
  };
}

/** Record that this process came up. Best-effort; never delays listen. */
export async function recordApiBoot(version: string, db: Db = defaultPrisma): Promise<void> {
  await db.apiBoot.create({
    data: { version: version.slice(0, 80), nodeVersion: process.version.slice(0, 40) },
  });
}
