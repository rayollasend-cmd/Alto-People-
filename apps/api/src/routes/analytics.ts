import { Router } from 'express';
import {
  UNPAID_BREAK_MIN,
  UNPAID_BREAK_THRESHOLD_MIN,
  DashboardKPIsSchema,
  OnboardingAnalyticsResponseSchema,
  RetentionResponseSchema,
  type DashboardKPIs,
  type OnboardingAnalyticsResponse,
  type OnboardingClientBreakdown,
  type OnboardingMonthlyPoint,
  type OnboardingTrackBreakdown,
} from '@alto-people/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { activeAssociateIds, activeHeadcount, activeWindowDays, placements } from '../lib/activeDefinition.js';
import { paidHoursByWeek, weekStartsEndingWith } from '../lib/paidHours.js';
import { peopleStandings, workStatusCounts } from '../lib/peopleStatus.js';
import { requireCapability } from '../middleware/auth.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { companyWorkweek, dateKeyInZone, endOfWeekUTC, startOfWeekUTC, utcInstantOfLocalMidnight } from '../lib/timeAnomalies.js';
import {
  associatesOfClient,
  effectiveClientIdFilter,
  internalSites,
  scopeAssociates,
  scopeAssociatesIncludingFormer,
  scopeShifts,
  scopeTimeEntries,
} from '../lib/scope.js';
import type { SessionUser } from '../types/express.js';

export const analyticsRouter = Router();

/* ---------------------------------------------------------------- helpers */

// The mount is view:dashboard (the home dashboard's KPIs), which every
// signed-in role holds. The analytics-page reads below are gated to the
// page's own audience: without it the watch-only FLOOR_SUPERVISOR (and
// the shift supervisor) could pull org-wide onboarding and retention.
const VIEW_ANALYTICS = requireCapability('view:analytics');
const NO_CLIENT = '00000000-0000-0000-0000-000000000000';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

/**
 * The sites the caller's numbers are narrowed to, beyond their client:
 * an office account bound to sites/regions, or a client account pinned to
 * one store (it gets that store, not the whole client). `null` = no site
 * narrowing. `ids` is the resolved list, for the raw-SQL trends.
 */
async function siteReach(user: SessionUser): Promise<{ where: Prisma.SiteWhereInput; ids: string[] } | null> {
  const internal = internalSites(user);
  const where: Prisma.SiteWhereInput | null = internal
    ? internal
    : user.role === 'CLIENT_PORTAL' && user.clientId && user.locationId
      ? { id: user.locationId }
      : null;
  if (!where) return null;
  const rows = await prisma.site.findMany({ where: { AND: [{ tenantId: tenantIdForWrite() }, where] }, select: { id: true } });
  return { where, ids: rows.map((r) => r.id) };
}

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
      bounded === null ? NO_CLIENT : bounded;
    const clientClamp = boundedClientId ? { clientId: boundedClientId } : {};
    const associateClamp = boundedClientId
      ? associatesOfClient(boundedClientId)
      : {};
    const isBounded = bounded !== undefined;
    // Site narrowing (a site-scoped office account, or a store-pinned
    // client account) and this tenant, on every number below.
    const T = tenantIdForWrite();
    const reach = await siteReach(req.user!);
    const appReach: Prisma.ApplicationWhereInput = reach ? { location: { is: reach.where } } : {};
    const sqlSites = reach ? Prisma.sql`AND "locationId" = ANY(${reach.ids}::uuid[])` : Prisma.empty;
    // Payroll dollars are a company number: never for a narrowed caller.
    const hidePayroll = isBounded || reach !== null;
    const activeInReach = async (): Promise<number> => {
      const scopeOpts = { tenantId: T, ...(boundedClientId ? { clientId: boundedClientId } : {}) };
      if (!reach) return activeHeadcount(scopeOpts, now);
      const ids = [...(await activeAssociateIds(scopeOpts, now))];
      if (ids.length === 0) return 0;
      return prisma.associate.count({ where: { AND: [{ id: { in: ids } }, scopeAssociates(req.user!)] } });
    };
    // "On the books" (hired, not separated) by the one status rule
    // (lib/peopleStatus), over the same people the caller reaches: the
    // number Headcount and the People directory show beside "Working".
    const onTheBooksInReach = async (): Promise<number> => {
      if (!isBounded && !reach) return (await workStatusCounts({ tenantId: T }, now)).onTheBooks;
      const ids = (
        await prisma.associate.findMany({ where: { AND: [{ tenantId: T, deletedAt: null }, associateClamp, scopeAssociates(req.user!)] }, select: { id: true } })
      ).map((r) => r.id);
      if (ids.length === 0) return 0;
      return (await workStatusCounts({ tenantId: T, associateIds: ids }, now)).onTheBooks;
    };

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
      // Brief 1A-2: the one definition of active, clamped to the caller's client.
      activeInReach(),
      // "Open shifts" (shared METRICS.openShifts): published with no one
      // assigned — status OPEN only — and not over yet, starting inside the
      // window. It counted ASSIGNED too and read 276 against Scheduling's 1
      // (deep audit LEAD-1).
      prisma.shift.count({
        where: {
          AND: [
            { tenantId: T, status: 'OPEN', assignedAssociateId: null, endsAt: { gt: now }, startsAt: { lte: in30 } },
            clientClamp,
            scopeShifts(req.user!),
          ],
        },
      }),
      prisma.timeEntry.count({ where: { AND: [{ tenantId: T, status: 'ACTIVE' }, clientClamp, scopeTimeEntries(req.user!)] } }),
      prisma.application.count({
        where: {
          AND: [{ tenantId: T, deletedAt: null, status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] } }, clientClamp, appReach],
        },
      }),
      // I-9s aren't client-attributable — bounded callers see 0 rather
      // than the org count.
      isBounded ? Promise.resolve(0) : i9Section2Backlog(T, req.user!),
      prisma.documentRecord.count({
        where: { AND: [{ tenantId: T, deletedAt: null, status: 'UPLOADED' }, clientClamp, { associate: scopeAssociates(req.user!) }] },
      }),
      // Org payroll dollars are never shown to bounded or site-narrowed callers.
      hidePayroll
        ? Promise.resolve({ _sum: { totalNet: null } })
        : prisma.payrollRun.aggregate({
            where: { tenantId: T, status: 'DISBURSED', disbursedAt: { gte: minus30 } },
            _sum: { totalNet: true },
          }),
      hidePayroll
        ? Promise.resolve({ _sum: { totalNet: null } })
        : prisma.payrollRun.aggregate({
            where: { tenantId: T, status: { in: ['DRAFT', 'FINALIZED'] } },
            _sum: { totalNet: true },
          }),
      prisma.application.groupBy({
        by: ['status'],
        where: { AND: [{ tenantId: T, deletedAt: null }, clientClamp, appReach] },
        _count: { _all: true },
      }),
      // Trend feeds. Hours worked are PAID hours (lib/paidHours): approved
      // or completed punches, every break out, punch rounding as pay rounds
      // it — the executive summary's definition, so this line and the
      // chairman's "hours last week" are one number. Bucketed by company
      // week (the last bucket is this week so far); summed in SQL unless a
      // live jurisdiction or a rounding policy needs the engine.
      paidHoursByWeek(prisma, {
        tenantId: T,
        weekStarts: weekStartsEndingWith(now, TREND_WEEKS),
        end: now,
        clientId: boundedClientId || null,
        siteIds: reach ? reach.ids : null,
      }),
      // Shifts are counted in SQL — this used to pull 10–20k timestamp rows
      // through the app per dashboard load to produce 8 weekly numbers. The
      // week index matches trendBucket exactly: floor((t − trendStart) / 1 week).
      prisma.$queryRaw<{ wk: number; n: bigint }[]>(Prisma.sql`
        SELECT
          FLOOR(EXTRACT(EPOCH FROM ("startsAt" - ${trendStart})) / 604800)::int AS wk,
          COUNT(*)::bigint AS n
        FROM "Shift"
        WHERE "startsAt" >= ${trendStart} AND "startsAt" < ${trendEnd}
          AND "status" <> 'CANCELLED'::"ShiftStatus"
          AND "tenantId" = ${T}::uuid
          ${boundedClientId ? Prisma.sql`AND "clientId" = ${boundedClientId}::uuid` : Prisma.empty}
          ${sqlSites}
        GROUP BY 1
      `),
      prisma.application.findMany({
        where: { AND: [{ tenantId: T, deletedAt: null, createdAt: { gte: trendStart, lt: trendEnd } }, clientClamp, appReach] },
        select: { createdAt: true },
      }),
      prisma.associate.findMany({
        where: {
          AND: [{ tenantId: T, deletedAt: null, createdAt: { gte: trendStart, lt: trendEnd } }, associateClamp, scopeAssociates(req.user!)],
        },
        select: { createdAt: true },
      }),
    ]);

    const applicationStatusCounts: Record<string, number> = {};
    for (const g of applicationStatusGroups) {
      applicationStatusCounts[g.status] = g._count._all;
    }

    // Paid hours per company week, to the hundredth (as the summary rounds a week).
    const hoursSeries = trendTimeEntries;
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
      hoursWorked: { series: hoursSeries, delta: Math.round(trendDelta(hoursSeries) * 100) / 100 },
      shiftsScheduled: { series: shiftsSeries, delta: trendDelta(shiftsSeries) },
      applications: { series: applicationsSeries, delta: trendDelta(applicationsSeries) },
      hires: { series: hiresSeries, delta: trendDelta(hiresSeries) },
    };

    // "Hours this week" and "Scheduled hours" (shared METRICS): the company
    // week so far — the same paid-hours bucket the trend's last point is —
    // and the week's non-cancelled shifts at their paid minutes
    // (paidMinutesForRange: start to end, less the hour's meal over six
    // hours), summed in SQL. The ops director's home reads this instead of
    // re-adding the labor-cost rows over a UTC week (552h vs 537h, LEAD-21).
    const weekEnd = endOfWeekUTC(now);
    const tz = companyWorkweek().timezone;
    const [onTheBooks, activeWindow, scheduledRows] = await Promise.all([
      onTheBooksInReach(),
      activeWindowDays(),
      prisma.$queryRaw<Array<{ hours: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(CASE WHEN m > ${UNPAID_BREAK_THRESHOLD_MIN} THEN m - ${UNPAID_BREAK_MIN} ELSE m END), 0)::float8 / 60 AS hours
        FROM (
          SELECT GREATEST(0, ROUND(EXTRACT(EPOCH FROM ("endsAt" - "startsAt")) / 60)) AS m
          FROM "Shift"
          WHERE "tenantId" = ${T}::uuid
            AND "status" <> 'CANCELLED'::"ShiftStatus"
            AND "startsAt" >= ${thisWeekStart} AND "startsAt" < ${weekEnd}
            ${boundedClientId ? Prisma.sql`AND "clientId" = ${boundedClientId}::uuid` : Prisma.empty}
            ${sqlSites}
        ) s
      `),
    ]);
    const lastDay = new Date(weekEnd.getTime() - 12 * 60 * 60 * 1000);
    const payload: DashboardKPIs = DashboardKPIsSchema.parse({
      activeAssociates,
      onTheBooks,
      activeWindowDays: activeWindow,
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
      week: {
        start: dateKeyInZone(thisWeekStart, tz),
        end: dateKeyInZone(lastDay, tz),
        timezone: tz,
        paidHours: hoursSeries.at(-1) ?? 0,
        scheduledHours: Math.round(Number(scheduledRows[0]?.hours ?? 0) * 100) / 100,
      },
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

/* ===== Retention ========================================================== *
 * Turnover trend, hiring-cohort survival, and per-store comparison —
 * computed from hireDate / separatedAt / assignments, no storage. An
 * associate's "store" is their FIRST assignment's location (where they
 * onboarded); separation reasons split voluntary vs involuntary.
 * ========================================================================== */

analyticsRouter.get('/retention', VIEW_ANALYTICS, async (req, res, next) => {
  try {
    const clamped = effectiveClientIdFilter(req.user!, req.query.clientId?.toString());
    const now = new Date();
    // One reading of where people stand (lib/peopleStatus): "active" is the
    // one definition, and hire and separation dates are the ones Headcount
    // and People analytics count — someone never hired is not a hire.
    const standings = await peopleStandings({ tenantId: tenantIdForWrite() }, now);
    // A site-narrowed caller (office account bound to sites, or a client
    // account pinned to a store) reads only people who worked those sites,
    // judged at the first of those sites they worked.
    const reach = await siteReach(req.user!);
    const reachIds = reach ? new Set(reach.ids) : null;
    const associates = await prisma.associate.findMany({
      // Brief 2-1: explicit tenant until enforce mode (cross-tenant suite).
      where: {
        AND: [
          { deletedAt: null, tenantId: tenantIdForWrite() },
          reach ? { assignments: { some: { location: { is: reach.where } } } } : {},
          scopeAssociatesIncludingFormer(req.user!),
        ],
      },
      select: {
        id: true,
        hireDate: true,
        createdAt: true,
        separatedAt: true,
        assignments: {
          orderBy: { startedAt: 'asc' },
          select: {
            endedAt: true,
            location: { select: { id: true, name: true, clientId: true } },
          },
        },
      },
      take: 10_000,
    });
    const separations = await prisma.separation.findMany({
      where: { tenantId: tenantIdForWrite() },
      select: { associateId: true, reason: true },
      take: 10_000,
    });
    const reasonByAssociate = new Map(separations.map((s) => [s.associateId, s.reason]));

    // Scope: bounded callers (and an explicit clientId filter) only count
    // associates who ever worked a site of that client.
    const rows = associates
      .flatMap((a) => {
        const s = standings.people.get(a.id);
        return s?.hiredOn ? [{ a, s, hired: s.hiredOn }] : [];
      })
      .map(({ a, s, hired }) => ({
        hired,
        separatedAt: s.leftAt,
        reason: reasonByAssociate.get(a.id) ?? null,
        // Their first store — within the caller's client when clamped, so
        // someone who started elsewhere never carries another client's
        // location (name + counts) into this client's comparison.
        firstLocation:
          (reachIds
            ? a.assignments.find((asg) => reachIds.has(asg.location.id) && (typeof clamped !== 'string' || asg.location.clientId === clamped))
            : typeof clamped === 'string'
              ? a.assignments.find((asg) => asg.location.clientId === clamped)
              : a.assignments[0]
          )?.location ?? null,
        activeNow: s.status === 'ACTIVE',
        clientIds: new Set(a.assignments.map((asg) => asg.location.clientId)),
      }))
      .filter((r) =>
        clamped === null
          ? false // bounded caller with no client on file — fail closed
          : clamped === undefined
            ? true
            : r.clientIds.has(clamped),
      );

    const monthStart = (offset: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const monthKey = (d: Date) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

    const monthly = [];
    for (let i = 11; i >= 0; i--) {
      const start = monthStart(i);
      const end = monthStart(i - 1);
      const headStart = rows.filter(
        (r) => r.hired < start && (r.separatedAt === null || r.separatedAt >= start),
      ).length;
      const headEnd = rows.filter(
        (r) => r.hired < end && (r.separatedAt === null || r.separatedAt >= end),
      ).length;
      const inMonth = (d: Date | null) => d !== null && d >= start && d < end;
      const seps = rows.filter((r) => inMonth(r.separatedAt));
      const avg = (headStart + headEnd) / 2;
      monthly.push({
        month: monthKey(start),
        headcountStart: headStart,
        hires: rows.filter((r) => r.hired >= start && r.hired < end).length,
        separations: seps.length,
        voluntary: seps.filter((r) => r.reason?.startsWith('VOLUNTARY')).length,
        involuntary: seps.filter((r) => r.reason?.startsWith('INVOLUNTARY')).length,
        turnoverPct: avg > 0 ? Math.round((seps.length / avg) * 1000) / 10 : null,
      });
    }

    const survivedDays = (r: { hired: Date; separatedAt: Date | null }, days: number) =>
      r.separatedAt === null ||
      r.separatedAt.getTime() - r.hired.getTime() >= days * ONE_DAY_MS;
    const cohorts = [];
    for (let i = 11; i >= 0; i--) {
      const start = monthStart(i);
      const end = monthStart(i - 1);
      const cohort = rows.filter((r) => r.hired >= start && r.hired < end);
      if (cohort.length === 0) continue;
      const rate = (days: number): number | null => {
        // Only measurable once the WHOLE cohort is at least `days` old.
        if (end.getTime() + days * ONE_DAY_MS > now.getTime()) return null;
        return Math.round(
          (cohort.filter((r) => survivedDays(r, days)).length / cohort.length) * 100,
        );
      };
      cohorts.push({
        month: monthKey(start),
        hires: cohort.length,
        s30: rate(30),
        s60: rate(60),
        s90: rate(90),
        s180: rate(180),
      });
    }

    const yearAgo = new Date(now.getTime() - 365 * ONE_DAY_MS);
    const byLocationMap = new Map<
      string,
      { name: string; active: number; seps: number; recentHires: number; survived90: number }
    >();
    for (const r of rows) {
      if (!r.firstLocation) continue;
      const agg = byLocationMap.get(r.firstLocation.id) ?? {
        name: r.firstLocation.name,
        active: 0,
        seps: 0,
        recentHires: 0,
        survived90: 0,
      };
      if (r.activeNow) agg.active += 1;
      if (r.separatedAt && r.separatedAt >= yearAgo) agg.seps += 1;
      // 90-day survival over hires old enough to measure (90–455 days ago).
      const age = now.getTime() - r.hired.getTime();
      if (age >= 90 * ONE_DAY_MS && age <= 455 * ONE_DAY_MS) {
        agg.recentHires += 1;
        if (survivedDays(r, 90)) agg.survived90 += 1;
      }
      byLocationMap.set(r.firstLocation.id, agg);
    }
    const byLocation = [...byLocationMap.entries()]
      .map(([locationId, v]) => ({
        locationId,
        locationName: v.name,
        active: v.active,
        separations12mo: v.seps,
        survival90Pct:
          v.recentHires > 0 ? Math.round((v.survived90 / v.recentHires) * 100) : null,
      }))
      .sort((a, b) => a.locationName.localeCompare(b.locationName));

    res.json(RetentionResponseSchema.parse({ monthly, cohorts, byLocation }));
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/onboarding', VIEW_ANALYTICS, async (req, res, next) => {
  try {
    // Tenant clamp: CLIENT_PORTAL holds view:analytics — it gets its own
    // client's funnel, never the org's per-client breakdown.
    const clamped = effectiveClientIdFilter(req.user!, undefined);
    // Brief 2-1: explicit tenant until enforce mode (cross-tenant suite).
    // …and a site-narrowed caller's stores only.
    const onboardingReach = await siteReach(req.user!);
    const clientClamp: Prisma.ApplicationWhereInput = {
      tenantId: tenantIdForWrite(),
      ...(clamped === undefined ? {} : { clientId: clamped ?? NO_CLIENT }),
      ...(onboardingReach ? { location: { is: onboardingReach.where } } : {}),
    };
    const now = new Date();
    const windowStart = new Date(now.getTime() - ANALYTICS_LOOKBACK_DAYS * ONE_DAY_MS);
    // Months are the company's calendar months (company time zone), not UTC's.
    const tz = companyWorkweek().timezone;
    const monthKeys: string[] = [];
    {
      const [cy, cm] = dateKeyInZone(now, tz).split('-').map(Number) as [number, number];
      for (let i = ANALYTICS_MONTHS - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(cy, cm - 1 - i, 1));
        monthKeys.push(monthKey(d));
      }
    }
    const monthlyStart = utcInstantOfLocalMidnight(`${monthKeys[0]}-01`, tz);

    // Every number below is aggregated in SQL over EVERY application in
    // scope (CODE-19): the route used to read `take: 500` rows with no
    // order, so past 500 applications the medians, the per-client counts
    // and the monthly chart came from an arbitrary subset. The where
    // clause is the Prisma clamp above in SQL: this tenant, not deleted,
    // the caller's client (fail closed when bounded with none), their sites.
    const appSql = Prisma.sql`a."tenantId" = ${tenantIdForWrite()}::uuid AND a."deletedAt" IS NULL
      ${clamped === undefined ? Prisma.empty : Prisma.sql`AND a."clientId" = ${clamped ?? NO_CLIENT}::uuid`}
      ${onboardingReach ? Prisma.sql`AND a."locationId" = ANY(${onboardingReach.ids}::uuid[])` : Prisma.empty}`;
    const daysSql = Prisma.sql`(EXTRACT(EPOCH FROM (a."submittedAt" - a."invitedAt"))::float8 / 86400)`;
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

    const [completionRows, trackRows, clientRows, invitedRows, completedRows] = await Promise.all([
      // Invite → submit, over the lookback (a negative span is bad data, left out).
      prisma.$queryRaw<Array<{ median: number | null; p90: number | null; n: number }>>(Prisma.sql`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d) AS median,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY d) AS p90,
               COUNT(*)::int AS n
        FROM (
          SELECT ${daysSql} AS d FROM "Application" a
          WHERE ${appSql} AND a."invitedAt" >= ${windowStart} AND a."submittedAt" IS NOT NULL
        ) x
        WHERE d >= 0
      `),
      // Per track: every invite in the window, and the median over the finished ones.
      prisma.$queryRaw<Array<{ track: string; count: number; completed: number; median: number | null }>>(Prisma.sql`
        SELECT a."onboardingTrack"::text AS track,
               COUNT(*)::int AS count,
               COUNT(*) FILTER (WHERE a."submittedAt" IS NOT NULL)::int AS completed,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ${daysSql}) FILTER (WHERE a."submittedAt" IS NOT NULL) AS median
        FROM "Application" a
        WHERE ${appSql} AND a."invitedAt" >= ${windowStart}
        GROUP BY 1
        ORDER BY 2 DESC, 1 ASC
      `),
      // Per client, the top N by invites (a client-less application — a direct employer — is in the totals only).
      prisma.$queryRaw<Array<{ clientId: string; clientName: string; count: number; completed: number; median: number | null }>>(Prisma.sql`
        SELECT a."clientId"::text AS "clientId",
               c."name" AS "clientName",
               COUNT(*)::int AS count,
               COUNT(*) FILTER (WHERE a."submittedAt" IS NOT NULL)::int AS completed,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ${daysSql}) FILTER (WHERE a."submittedAt" IS NOT NULL) AS median
        FROM "Application" a
        JOIN "Client" c ON c."id" = a."clientId"
        WHERE ${appSql} AND a."invitedAt" >= ${windowStart}
        GROUP BY a."clientId", c."name"
        ORDER BY count DESC, c."name" ASC
        LIMIT ${ANALYTICS_TOP_CLIENTS}
      `),
      // Invited per company month, and how many of that month's invites have finished since.
      prisma.$queryRaw<Array<{ month: string; invited: number; invitedCompleted: number }>>(Prisma.sql`
        SELECT to_char(a."invitedAt" AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
               COUNT(*)::int AS invited,
               COUNT(*) FILTER (WHERE a."submittedAt" IS NOT NULL)::int AS "invitedCompleted"
        FROM "Application" a
        WHERE ${appSql} AND a."invitedAt" >= ${monthlyStart}
        GROUP BY 1
      `),
      // Submitted per company month.
      prisma.$queryRaw<Array<{ month: string; completed: number }>>(Prisma.sql`
        SELECT to_char(a."submittedAt" AT TIME ZONE ${tz}, 'YYYY-MM') AS month, COUNT(*)::int AS completed
        FROM "Application" a
        WHERE ${appSql} AND a."submittedAt" >= ${monthlyStart}
        GROUP BY 1
      `),
    ]);

    // Snapshot of *all* applications by status (no time filter — HR wants
    // to see where everyone is right now).
    const statusGroups = await prisma.application.groupBy({
      by: ['status'],
      where: { deletedAt: null, ...clientClamp },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const g of statusGroups) byStatus[g.status] = g._count._all;

    const completion = completionRows[0];
    const byTrack: OnboardingTrackBreakdown[] = trackRows.map((r) => ({
      track: r.track as OnboardingTrackBreakdown['track'],
      count: Number(r.count),
      medianDays: num(r.median),
      // The median's sample: the page says "too few to tell" under 3.
      completed: Number(r.completed),
    }));
    const byClient: OnboardingClientBreakdown[] = clientRows.map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName,
      count: Number(r.count),
      medianDays: num(r.median),
      completed: Number(r.completed),
    }));
    const invitedBy = new Map(invitedRows.map((r) => [r.month, r]));
    const completedBy = new Map(completedRows.map((r) => [r.month, Number(r.completed)]));
    // Every month present, so the chart has full coverage even when a quiet month had zero of both.
    const monthly: OnboardingMonthlyPoint[] = monthKeys.map((month) => ({
      month,
      invited: Number(invitedBy.get(month)?.invited ?? 0),
      completed: completedBy.get(month) ?? 0,
      invitedCompleted: Number(invitedBy.get(month)?.invitedCompleted ?? 0),
    }));

    const payload: OnboardingAnalyticsResponse =
      OnboardingAnalyticsResponseSchema.parse({
        windowDays: ANALYTICS_LOOKBACK_DAYS,
        byStatus,
        completion: {
          medianDays: num(completion?.median),
          p90Days: num(completion?.p90),
          sample: Number(completion?.n ?? 0),
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

/**
 * People whose I-9 Section 2 is still owed — the same count as the
 * Compliance I-9 tab's "Section 2 pending" tile: records without Section 2,
 * plus the placed people with no I-9 record at all (their Section 2 clock
 * runs from their hire date). This tile read 0 while the tab listed 33
 * "Section 2 due" rows (F500 audit 2026-10-26).
 */
async function i9Section2Backlog(tenantId: string, user: SessionUser): Promise<number> {
  const reach = { AND: [{ deletedAt: null }, scopeAssociates(user)] };
  const [pending, placed] = await Promise.all([
    prisma.i9Verification.count({ where: { tenantId, section2CompletedAt: null, associate: reach } }),
    placements({ tenantId }, prisma),
  ]);
  if (placed.size === 0) return pending;
  const withRecord = await prisma.i9Verification.findMany({ where: { tenantId, associateId: { in: [...placed.keys()] } }, select: { associateId: true } });
  const has = new Set(withRecord.map((r) => r.associateId));
  const missing = [...placed.keys()].filter((id) => !has.has(id));
  if (missing.length === 0) return pending;
  const notStarted = await prisma.associate.count({ where: { AND: [{ id: { in: missing } }, { tenantId }, reach] } });
  return pending + notStarted;
}
