import { Router } from 'express';
import {
  DashboardKPIsSchema,
  OnboardingAnalyticsResponseSchema,
  type DashboardKPIs,
  type OnboardingAnalyticsResponse,
  type OnboardingClientBreakdown,
  type OnboardingMonthlyPoint,
  type OnboardingTrackBreakdown,
} from '@alto-people/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { startOfWeekUTC } from '../lib/timeAnomalies.js';
import { associatesOfClient, effectiveClientIdFilter } from '../lib/scope.js';

export const analyticsRouter = Router();

/* ---------------------------------------------------------------- helpers */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

/** Number of weekly buckets in each KPI micro-trend (ending this week). */
const TREND_WEEKS = 8;

/** Bucket index (0..TREND_WEEKS-1) for an instant, or -1 when outside. */
function trendBucket(d: Date, trendStart: Date): number {
  const idx = Math.floor((d.getTime() - trendStart.getTime()) / ONE_WEEK_MS);
  return idx >= 0 && idx < TREND_WEEKS ? idx : -1;
}

/** Weekly count series for a list of event timestamps. */
function weeklyCounts(dates: Date[], trendStart: Date): number[] {
  const series = new Array<number>(TREND_WEEKS).fill(0);
  for (const d of dates) {
    const i = trendBucket(d, trendStart);
    if (i >= 0) series[i] += 1;
  }
  return series;
}

/** delta = last COMPLETE week vs the week before it. The final bucket is
 *  the in-progress week, so comparing it would always read as a dip. */
function trendDelta(series: number[]): number {
  const lastComplete = series[series.length - 2] ?? 0;
  const prior = series[series.length - 3] ?? 0;
  return lastComplete - prior;
}

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / ONE_DAY_MS;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // Linear interpolation between two ranks; standard "p9 = days at the
  // 90th-percentile boundary." For our purposes (HR dashboards, not
  // statistical inference) this is plenty accurate.
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/** Inclusive YYYY-MM key in UTC for the given Date. */
function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * One-shot dashboard payload. Each chunk is a single COUNT or aggregate;
 * Promise.all parallelizes them. If any single query fails, the whole
 * response fails — that's acceptable for v1 since these queries are simple.
 */
analyticsRouter.get('/dashboard', async (req, res, next) => {
  try {
    const now = new Date();
    // Window is symmetric: scheduling looks N days forward, payroll looks N
    // days back. Bounded so a malformed query can't make the route do hours
    // of date math against the whole table.
    const requestedDays = Number(req.query.days);
    const days =
      Number.isFinite(requestedDays) && requestedDays >= 1 && requestedDays <= 365
        ? Math.floor(requestedDays)
        : 30;
    const windowMs = days * 24 * 60 * 60 * 1000;
    const in30 = new Date(now.getTime() + windowMs);
    const minus30 = new Date(now.getTime() - windowMs);

    // Micro-trend window: TREND_WEEKS UTC weeks ending with the current
    // (partial) week. Every trend query below is bounded to this range so
    // the dashboard never scans whole tables.
    const thisWeekStart = startOfWeekUTC(now);
    const trendStart = new Date(
      thisWeekStart.getTime() - (TREND_WEEKS - 1) * ONE_WEEK_MS
    );
    const trendEnd = new Date(thisWeekStart.getTime() + ONE_WEEK_MS);

    // Tenant clamp: a client-bounded caller (SHIFT_SUPERVISOR) gets THEIR
    // site's numbers, not the org's — and never sees org payroll dollars.
    // (`null` = bounded-but-unassigned → fail closed via an impossible id.)
    const bounded = effectiveClientIdFilter(req.user!, undefined);
    const boundedClientId =
      bounded === null ? '00000000-0000-0000-0000-000000000000' : bounded;
    const clientClamp = boundedClientId ? { clientId: boundedClientId } : {};
    const associateClamp = boundedClientId
      ? associatesOfClient(boundedClientId)
      : {};
    const isBounded = bounded !== undefined;

    const [
      activeAssociates,
      openShiftsNext30d,
      associatesClockedIn,
      pendingOnboardingApplications,
      pendingI9Section2,
      pendingDocumentReviews,
      paidAggregate,
      pendingDisbursementAggregate,
      applicationStatusGroups,
      trendTimeEntries,
      trendShifts,
      trendApplications,
      trendHires,
    ] = await Promise.all([
      prisma.associate.count({ where: { deletedAt: null, ...associateClamp } }),
      prisma.shift.count({
        where: {
          status: { in: ['OPEN', 'ASSIGNED'] },
          startsAt: { gte: now, lte: in30 },
          ...clientClamp,
        },
      }),
      prisma.timeEntry.count({ where: { status: 'ACTIVE', ...clientClamp } }),
      prisma.application.count({
        where: {
          deletedAt: null,
          status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] },
          ...clientClamp,
        },
      }),
      // I-9s aren't client-attributable — bounded callers see 0 rather
      // than the org count.
      isBounded
        ? Promise.resolve(0)
        : prisma.i9Verification.count({ where: { section2CompletedAt: null } }),
      prisma.documentRecord.count({
        where: { deletedAt: null, status: 'UPLOADED', ...clientClamp },
      }),
      // Org payroll dollars are never shown to bounded roles.
      isBounded
        ? Promise.resolve({ _sum: { totalNet: null } })
        : prisma.payrollRun.aggregate({
            where: { status: 'DISBURSED', disbursedAt: { gte: minus30 } },
            _sum: { totalNet: true },
          }),
      isBounded
        ? Promise.resolve({ _sum: { totalNet: null } })
        : prisma.payrollRun.aggregate({
            where: { status: { in: ['DRAFT', 'FINALIZED'] } },
            _sum: { totalNet: true },
          }),
      prisma.application.groupBy({
        by: ['status'],
        where: { deletedAt: null, ...clientClamp },
        _count: { _all: true },
      }),
      // Trend feeds. Hours + shifts are aggregated in SQL — these two
      // used to pull 10–20k timestamp rows through the app per dashboard
      // load to produce 8 weekly numbers. The week index matches
      // trendBucket exactly: floor((t − trendStart) / 1 week).
      prisma.$queryRaw<{ wk: number; hours: number }[]>(Prisma.sql`
        SELECT
          FLOOR(EXTRACT(EPOCH FROM ("clockInAt" - ${trendStart})) / 604800)::int AS wk,
          COALESCE(SUM(
            CASE WHEN "clockOutAt" > "clockInAt"
              THEN EXTRACT(EPOCH FROM ("clockOutAt" - "clockInAt")) / 3600
              ELSE 0 END
          ), 0)::float8 AS hours
        FROM "TimeEntry"
        WHERE "clockInAt" >= ${trendStart} AND "clockInAt" < ${trendEnd}
          AND "clockOutAt" IS NOT NULL
          ${boundedClientId ? Prisma.sql`AND "clientId" = ${boundedClientId}::uuid` : Prisma.empty}
        GROUP BY 1
      `),
      prisma.$queryRaw<{ wk: number; n: bigint }[]>(Prisma.sql`
        SELECT
          FLOOR(EXTRACT(EPOCH FROM ("startsAt" - ${trendStart})) / 604800)::int AS wk,
          COUNT(*)::bigint AS n
        FROM "Shift"
        WHERE "startsAt" >= ${trendStart} AND "startsAt" < ${trendEnd}
          AND "status" <> 'CANCELLED'::"ShiftStatus"
          ${boundedClientId ? Prisma.sql`AND "clientId" = ${boundedClientId}::uuid` : Prisma.empty}
        GROUP BY 1
      `),
      prisma.application.findMany({
        where: {
          deletedAt: null,
          createdAt: { gte: trendStart, lt: trendEnd },
          ...clientClamp,
        },
        select: { createdAt: true },
      }),
      prisma.associate.findMany({
        where: {
          deletedAt: null,
          createdAt: { gte: trendStart, lt: trendEnd },
          ...associateClamp,
        },
        select: { createdAt: true },
      }),
    ]);

    const applicationStatusCounts: Record<string, number> = {};
    for (const g of applicationStatusGroups) {
      applicationStatusCounts[g.status] = g._count._all;
    }

    // Hours worked per week, bucketed by clock-in and rounded to 0.1h.
    const hoursSeries = new Array<number>(TREND_WEEKS).fill(0);
    for (const g of trendTimeEntries) {
      if (g.wk >= 0 && g.wk < TREND_WEEKS) {
        hoursSeries[g.wk] = Math.round(g.hours * 10) / 10;
      }
    }
    const shiftsSeries = new Array<number>(TREND_WEEKS).fill(0);
    for (const g of trendShifts) {
      if (g.wk >= 0 && g.wk < TREND_WEEKS) {
        shiftsSeries[g.wk] = Number(g.n);
      }
    }
    const applicationsSeries = weeklyCounts(
      trendApplications.map((a) => a.createdAt),
      trendStart
    );
    const hiresSeries = weeklyCounts(
      trendHires.map((a) => a.createdAt),
      trendStart
    );
    const trends: DashboardKPIs['trends'] = {
      hoursWorked: { series: hoursSeries, delta: Math.round(trendDelta(hoursSeries) * 10) / 10 },
      shiftsScheduled: { series: shiftsSeries, delta: trendDelta(shiftsSeries) },
      applications: { series: applicationsSeries, delta: trendDelta(applicationsSeries) },
      hires: { series: hiresSeries, delta: trendDelta(hiresSeries) },
    };

    const payload: DashboardKPIs = DashboardKPIsSchema.parse({
      activeAssociates,
      openShiftsNext30d,
      associatesClockedIn,
      pendingOnboardingApplications,
      pendingI9Section2,
      pendingDocumentReviews,
      netPaidLast30d: Number(paidAggregate._sum.totalNet ?? 0),
      netPendingDisbursement: Number(pendingDisbursementAggregate._sum.totalNet ?? 0),
      applicationStatusCounts,
      windowDays: days,
      trends,
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/* ===== Phase 62 — onboarding time-to-completion analytics ============= */
//
// Lookback is fixed at 90 days; could become a query param later if HR
// asks. We don't bother gating by client/role here — the analytics router
// already requires view:dashboard, and onboarding metrics aren't
// employee-PII (just counts and durations).

const ANALYTICS_LOOKBACK_DAYS = 90;
const ANALYTICS_TOP_CLIENTS = 10;
const ANALYTICS_MONTHS = 6;

analyticsRouter.get('/onboarding', async (_req, res, next) => {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - ANALYTICS_LOOKBACK_DAYS * ONE_DAY_MS);
    const monthlyStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (ANALYTICS_MONTHS - 1), 1)
    );

    // Snapshot of *all* applications by status (no time filter — HR wants
    // to see where everyone is right now).
    const statusGroups = await prisma.application.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const g of statusGroups) byStatus[g.status] = g._count._all;

    // Window: applications invited within the lookback. Used for the
    // completion / track / client / monthly stats.
    const inWindow = await prisma.application.findMany({
      take: 500,
      where: { deletedAt: null, invitedAt: { gte: windowStart } },
      select: {
        clientId: true,
        onboardingTrack: true,
        invitedAt: true,
        submittedAt: true,
        client: { select: { name: true } },
      },
    });

    const completed = inWindow.filter(
      (a): a is typeof a & { submittedAt: Date } => a.submittedAt !== null
    );
    const completionDays = completed
      .map((a) => daysBetween(a.invitedAt, a.submittedAt))
      .filter((n) => n >= 0)
      .sort((a, b) => a - b);

    // Track breakdown: median per track, count per track.
    const byTrackMap = new Map<string, number[]>();
    for (const a of completed) {
      const key = a.onboardingTrack;
      const arr = byTrackMap.get(key) ?? [];
      arr.push(daysBetween(a.invitedAt, a.submittedAt));
      byTrackMap.set(key, arr);
    }
    // Add invited-but-not-completed counts so a track HR is using shows
    // up even if nobody has finished yet within the window.
    const trackCounts: Record<string, number> = {};
    for (const a of inWindow) {
      trackCounts[a.onboardingTrack] = (trackCounts[a.onboardingTrack] ?? 0) + 1;
    }
    const byTrack: OnboardingTrackBreakdown[] = Object.entries(trackCounts)
      .map(([track, count]) => {
        const sorted = (byTrackMap.get(track) ?? []).sort((a, b) => a - b);
        return {
          track: track as OnboardingTrackBreakdown['track'],
          count,
          medianDays: median(sorted),
        };
      })
      .sort((a, b) => b.count - a.count);

    // Client breakdown: top N by application count in the window. Median
    // is over the completed subset for that client.
    const byClientMap = new Map<
      string,
      { name: string; count: number; days: number[] }
    >();
    for (const a of inWindow) {
      const entry = byClientMap.get(a.clientId) ?? {
        name: a.client.name,
        count: 0,
        days: [],
      };
      entry.count += 1;
      if (a.submittedAt) entry.days.push(daysBetween(a.invitedAt, a.submittedAt));
      byClientMap.set(a.clientId, entry);
    }
    const byClient: OnboardingClientBreakdown[] = Array.from(byClientMap.entries())
      .map(([clientId, v]) => ({
        clientId,
        clientName: v.name,
        count: v.count,
        medianDays: median(v.days.sort((a, b) => a - b)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, ANALYTICS_TOP_CLIENTS);

    // Monthly invited vs completed — a different (longer) window than
    // the completion stats. Pull both invited and completed events that
    // fall in the last N months.
    const monthlyApps = await prisma.application.findMany({
      take: 500,
      where: {
        deletedAt: null,
        OR: [
          { invitedAt: { gte: monthlyStart } },
          { submittedAt: { gte: monthlyStart } },
        ],
      },
      select: { invitedAt: true, submittedAt: true },
    });

    const monthlyMap = new Map<string, { invited: number; completed: number }>();
    // Pre-seed with empty months so the chart has full coverage even if
    // a quiet month had zero of both.
    for (let i = 0; i < ANALYTICS_MONTHS; i++) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)
      );
      monthlyMap.set(monthKey(d), { invited: 0, completed: 0 });
    }
    for (const a of monthlyApps) {
      if (a.invitedAt >= monthlyStart) {
        const k = monthKey(a.invitedAt);
        const entry = monthlyMap.get(k);
        if (entry) entry.invited += 1;
      }
      if (a.submittedAt && a.submittedAt >= monthlyStart) {
        const k = monthKey(a.submittedAt);
        const entry = monthlyMap.get(k);
        if (entry) entry.completed += 1;
      }
    }
    const monthly: OnboardingMonthlyPoint[] = Array.from(monthlyMap.entries())
      .map(([month, v]) => ({ month, invited: v.invited, completed: v.completed }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const payload: OnboardingAnalyticsResponse =
      OnboardingAnalyticsResponseSchema.parse({
        windowDays: ANALYTICS_LOOKBACK_DAYS,
        byStatus,
        completion: {
          medianDays: median(completionDays),
          p90Days: percentile(completionDays, 90),
          sample: completionDays.length,
        },
        byTrack,
        byClient,
        monthly,
      });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});
