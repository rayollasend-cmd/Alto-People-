import { Router } from 'express';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';

export const productAnalyticsRouter = Router();

/**
 * IS ANYONE ACTUALLY USING THIS?
 *
 * The existing /analytics answers questions about the workforce —
 * retention, onboarding funnels, questions about associates. Nothing
 * answered questions about the product itself, so "did the Relay
 * workstation land?" had no answer but anecdote.
 *
 * Every read here hits a rollup written by lib/usageTracker. None of it
 * touches AuditLog: that table carries 209 action types and has no
 * retention sweep, and its indexes serve entity timelines, so aggregating
 * it would scan an ever-growing table and contend with the write path that
 * every mutation depends on.
 *
 * The window is bounded on the way in (MAX_DAYS) rather than trusted from
 * the query string — an unbounded `days` is how a dashboard becomes an
 * outage.
 */

const VIEW = requireCapability('view:product-analytics');

/** Roughly a year. Past this the rollups want a chart, not a table. */
const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function parseDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(Math.floor(n), MAX_DAYS);
}

/** UTC midnight `days` ago, inclusive of today. */
function windowStart(days: number, now = new Date()): Date {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(today.getTime() - (days - 1) * ONE_DAY_MS);
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * GET /product-analytics/active-users?days=30
 *
 * DAU per day, plus WAU and MAU as of today. The rolling figures are one
 * COUNT DISTINCT each over an indexed day range rather than 30 separate
 * queries — the shape people usually get wrong when they compute a
 * trailing window per point.
 */
productAnalyticsRouter.get('/active-users', VIEW, async (req, res, next) => {
  try {
    const days = parseDays(req.query.days);
    const from = windowStart(days);
    const now = new Date();

    const rows = await prisma.userActivityDay.groupBy({
      by: ['day'],
      where: { day: { gte: from } },
      _count: { userId: true },
      orderBy: { day: 'asc' },
    });

    const byDay = new Map(rows.map((r) => [dayKey(r.day), r._count.userId]));
    const series: { day: string; activeUsers: number }[] = [];
    for (let i = 0; i < days; i++) {
      const d = dayKey(new Date(from.getTime() + i * ONE_DAY_MS));
      series.push({ day: d, activeUsers: byDay.get(d) ?? 0 });
    }

    const distinctSince = async (since: Date) =>
      (
        await prisma.userActivityDay.findMany({
          where: { day: { gte: since } },
          distinct: ['userId'],
          select: { userId: true },
        })
      ).length;

    const [wau, mau] = await Promise.all([
      distinctSince(new Date(windowStart(7, now))),
      distinctSince(new Date(windowStart(30, now))),
    ]);

    res.json({
      series,
      dau: series[series.length - 1]?.activeUsers ?? 0,
      wau,
      mau,
      // The industry's stickiness ratio. Reported as a number, not a
      // verdict — what counts as good depends entirely on the product.
      stickiness: mau > 0 ? Math.round((wau / mau) * 100) / 100 : 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /product-analytics/traffic?days=30
 *
 * Requests and error rates per day, from the route rollup.
 */
productAnalyticsRouter.get('/traffic', VIEW, async (req, res, next) => {
  try {
    const days = parseDays(req.query.days);
    const from = windowStart(days);

    const rows = await prisma.routeUsageDaily.groupBy({
      by: ['day'],
      where: { day: { gte: from } },
      _sum: { ok: true, clientError: true, serverError: true, totalMs: true },
      orderBy: { day: 'asc' },
    });

    const byDay = new Map(rows.map((r) => [dayKey(r.day), r._sum]));
    const series = [];
    for (let i = 0; i < days; i++) {
      const d = dayKey(new Date(from.getTime() + i * ONE_DAY_MS));
      const s = byDay.get(d);
      const ok = s?.ok ?? 0;
      const clientError = s?.clientError ?? 0;
      const serverError = s?.serverError ?? 0;
      const total = ok + clientError + serverError;
      series.push({
        day: d,
        requests: total,
        clientError,
        serverError,
        // Server errors only. A 404 or a 403 is usually the app working.
        errorRate: total > 0 ? Math.round((serverError / total) * 10_000) / 10_000 : 0,
        avgMs: total > 0 ? Math.round(Number(s?.totalMs ?? 0n) / total) : 0,
      });
    }
    res.json({ series });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /product-analytics/routes?days=30&limit=25
 *
 * What the product is actually used for, busiest first, and the routes
 * failing most often. Keys are Express patterns — no entity ids.
 */
productAnalyticsRouter.get('/routes', VIEW, async (req, res, next) => {
  try {
    const days = parseDays(req.query.days);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const from = windowStart(days);

    const rows = await prisma.routeUsageDaily.groupBy({
      by: ['method', 'route'],
      where: { day: { gte: from } },
      _sum: { ok: true, clientError: true, serverError: true, totalMs: true },
    });

    const shaped = rows.map((r) => {
      const ok = r._sum.ok ?? 0;
      const clientError = r._sum.clientError ?? 0;
      const serverError = r._sum.serverError ?? 0;
      const requests = ok + clientError + serverError;
      return {
        method: r.method,
        route: r.route,
        requests,
        serverError,
        errorRate: requests > 0 ? Math.round((serverError / requests) * 10_000) / 10_000 : 0,
        avgMs: requests > 0 ? Math.round(Number(r._sum.totalMs ?? 0n) / requests) : 0,
      };
    });

    res.json({
      busiest: [...shaped].sort((a, b) => b.requests - a.requests).slice(0, limit),
      // Needs a floor: one 500 out of one call is a 100% error rate and
      // tells nobody anything.
      failing: shaped
        .filter((r) => r.serverError > 0 && r.requests >= 20)
        .sort((a, b) => b.errorRate - a.errorRate)
        .slice(0, limit),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /product-analytics/adoption?days=30
 *
 * Growth and the signup→login funnel: accounts created in the window, how
 * many ever signed in, and who has gone quiet. The last one is the number
 * that usually starts a conversation.
 */
productAnalyticsRouter.get('/adoption', VIEW, async (req, res, next) => {
  try {
    const days = parseDays(req.query.days);
    const from = windowStart(days);
    const now = new Date();

    const [created, activatedRows, byRole, never, dormant, total] = await Promise.all([
      prisma.user.groupBy({
        by: ['createdAt'],
        where: { createdAt: { gte: from }, deletedAt: null },
        _count: { _all: true },
      }),
      // Accounts made in the window that have since been seen at all.
      prisma.user.count({
        where: { createdAt: { gte: from }, deletedAt: null, lastSeenAt: { not: null } },
      }),
      prisma.userActivityDay.findMany({
        where: { day: { gte: windowStart(30, now) } },
        distinct: ['userId', 'role'],
        select: { role: true, userId: true },
      }),
      // Invited, never once signed in — the funnel's real leak.
      prisma.user.count({ where: { deletedAt: null, lastSeenAt: null, status: { not: 'DISABLED' } } }),
      prisma.user.count({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          lastSeenAt: { lt: new Date(now.getTime() - 30 * ONE_DAY_MS) },
        },
      }),
      prisma.user.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
    ]);

    const signupsByDay = new Map<string, number>();
    for (const c of created) {
      const k = dayKey(c.createdAt);
      signupsByDay.set(k, (signupsByDay.get(k) ?? 0) + c._count._all);
    }
    const signups = [];
    for (let i = 0; i < days; i++) {
      const d = dayKey(new Date(from.getTime() + i * ONE_DAY_MS));
      signups.push({ day: d, accounts: signupsByDay.get(d) ?? 0 });
    }

    const roleCounts = new Map<string, number>();
    for (const r of byRole) roleCounts.set(r.role, (roleCounts.get(r.role) ?? 0) + 1);

    const createdTotal = created.reduce((s, c) => s + c._count._all, 0);
    res.json({
      signups,
      funnel: {
        created: createdTotal,
        activated: activatedRows,
        activationRate: createdTotal > 0 ? Math.round((activatedRows / createdTotal) * 100) / 100 : 0,
      },
      activeByRole: [...roleCounts.entries()]
        .map(([role, users]) => ({ role, users }))
        .sort((a, b) => b.users - a.users),
      neverSignedIn: never,
      dormant30d: dormant,
      totalActiveAccounts: total,
    });
  } catch (err) {
    next(err);
  }
});
