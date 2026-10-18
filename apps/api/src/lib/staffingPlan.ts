import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { internalSites, isClientBoundedRole } from './scope.js';
import { defaultDemandFor } from './seasonPlanner.js';
import { orgDateKey, startOfWeekUTC } from './timeAnomalies.js';
import { loadRateCards } from './rateCards.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * The headcount plan a staffing company runs on: heads required against
 * heads in place, store by store, week by week.
 *
 * What a store needs in a week comes from the best source it has, in order:
 *
 *   season plan  the floor headcount the planner holds for that week
 *                (day + evening + overnight), turned into people the same
 *                way the planner does: slots × 7 ÷ shifts a person works ×
 *                (1 + reserve)
 *   forecast     the latest demand forecast's p50 hours for that week,
 *                ÷ the target week (40 h) × (1 + 10% reserve)
 *   targets      the store's standing staffing targets, as the planner
 *                defaults them
 *
 * Against it: the people placed there now (an open assignment) and the
 * people actually scheduled that week. The budget is the week's hours at
 * the client's bill rates in force today (their average) — an estimate,
 * said so on the page.
 */

const DAY = 86_400_000;
const DEFAULT_WEEK_HOURS = 40;
const DEFAULT_SHIFT_HOURS = 8;
const DEFAULT_RESERVE = 10;

export type DemandSource = 'season' | 'forecast' | 'targets' | 'none';

export interface StaffingWeek {
  week: string;
  required: number;
  placed: number;
  scheduled: number;
  gap: number;
  hours: number;
  budget: number | null;
  source: DemandSource;
}

export interface StaffingStore {
  storeId: string;
  storeName: string;
  clientId: string | null;
  clientName: string | null;
  placed: number;
  weeks: StaffingWeek[];
}

export interface StaffingPlan {
  weeks: string[];
  stores: StaffingStore[];
  totals: Array<{ week: string; required: number; placed: number; scheduled: number; gap: number; budget: number | null }>;
  /** Stores with a bill rate to price the plan with. */
  priced: number;
}

const headsFor = (dailyFloor: number, weekHours: number, shiftHours: number, reservePct: number) => {
  if (dailyFloor <= 0) return { heads: 0, hours: 0 };
  const slots = dailyFloor * 7;
  const shiftsPerPerson = Math.max(1, weekHours / Math.max(1, shiftHours));
  return { heads: Math.ceil((slots / shiftsPerPerson) * (1 + reservePct / 100)), hours: slots * shiftHours };
};

export async function buildStaffingPlan(user: SessionUser, opts: { weeks: number; clientId?: string | null }, now = new Date()): Promise<StaffingPlan> {
  const tenantId = tenantIdForWrite();
  const first = startOfWeekUTC(now);
  const starts = Array.from({ length: opts.weeks }, (_, i) => new Date(first.getTime() + i * 7 * DAY));
  const weeks = starts.map((d) => orgDateKey(new Date(d.getTime() + 12 * 3_600_000)));
  const end = new Date(first.getTime() + opts.weeks * 7 * DAY);

  const bounded = isClientBoundedRole(user);
  const where: Prisma.SiteWhereInput = {
    AND: [
      { tenantId, deletedAt: null, isActive: true, type: { in: ['STORE', 'PROPERTY', 'WAREHOUSE'] } },
      internalSites(user) ?? {},
      opts.clientId ? { clientId: opts.clientId } : {},
      bounded ? (user.clientId ? { clientId: user.clientId } : { id: '00000000-0000-0000-0000-000000000000' }) : {},
    ],
  };
  const sites = await prisma.site.findMany({
    where,
    orderBy: { name: 'asc' },
    take: 500,
    select: { id: true, name: true, clientId: true, client: { select: { name: true, deletedAt: true } } },
  });
  const live = sites.filter((s) => !s.client?.deletedAt);
  const ids = live.map((s) => s.id);
  if (ids.length === 0) return { weeks, stores: [], totals: weeks.map((week) => ({ week, required: 0, placed: 0, scheduled: 0, gap: 0, budget: null })), priced: 0 };

  const [plans, latestRun, placedRows, shifts, targets, cards] = await Promise.all([
    prisma.seasonPlan.findMany({
      where: { tenantId, archivedAt: null, seasonStart: { lte: end }, seasonEnd: { gte: first } },
      orderBy: { updatedAt: 'desc' },
      select: { targetHoursPerWeek: true, shiftHours: true, reservePct: true, sites: { where: { locationId: { in: ids } }, select: { locationId: true, demand: true } } },
    }),
    prisma.forecastRun.findFirst({ where: { tenantId }, orderBy: { generatedAt: 'desc' }, select: { id: true } }),
    prisma.associateAssignment.groupBy({
      by: ['locationId'],
      where: { locationId: { in: ids }, endedAt: null, associate: { deletedAt: null, deactivatedAt: null } },
      _count: { _all: true },
    }),
    prisma.shift.findMany({
      where: { locationId: { in: ids }, status: { not: 'CANCELLED' }, assignedAssociateId: { not: null }, startsAt: { gte: first, lt: end } },
      select: { locationId: true, startsAt: true, assignedAssociateId: true },
      take: 100_000,
    }),
    defaultDemandFor(prisma, ids, weeks),
    loadRateCards(prisma, [...new Set(live.map((s) => s.clientId))]),
  ]);
  const forecast = latestRun
    ? await prisma.forecastSiteWeek.findMany({ where: { runId: latestRun.id, locationId: { in: ids }, weekStart: { gte: first, lt: end } }, select: { locationId: true, weekStart: true, p50: true } })
    : [];

  // Season demand per store-week, from the most recently edited plan that holds it.
  const season = new Map<string, { daily: number; weekHours: number; shiftHours: number; reserve: number }>();
  for (const p of plans) {
    for (const s of p.sites) {
      for (const d of Array.isArray(s.demand) ? (s.demand as Array<{ week?: string; day?: number; evening?: number; overnight?: number }>) : []) {
        if (!d?.week) continue;
        const key = `${s.locationId}|${d.week}`;
        if (season.has(key)) continue;
        const daily = (Number(d.day) || 0) + (Number(d.evening) || 0) + (Number(d.overnight) || 0);
        if (daily > 0) season.set(key, { daily, weekHours: p.targetHoursPerWeek, shiftHours: p.shiftHours, reserve: p.reservePct });
      }
    }
  }
  const forecastBy = new Map(forecast.map((f) => [`${f.locationId}|${orgDateKey(new Date(f.weekStart.getTime() + 12 * 3_600_000))}`, f.p50]));
  const placedBy = new Map(placedRows.map((r) => [r.locationId, r._count._all]));
  const scheduledBy = new Map<string, Set<string>>();
  for (const s of shifts) {
    const w = weeks[Math.floor((s.startsAt.getTime() - first.getTime()) / (7 * DAY))];
    if (!w || !s.locationId) continue;
    const key = `${s.locationId}|${w}`;
    const set = scheduledBy.get(key) ?? new Set<string>();
    set.add(s.assignedAssociateId!);
    scheduledBy.set(key, set);
  }
  // The client's bill rate: the average of its cards in force today.
  const today = now.toISOString().slice(0, 10);
  const rateBy = new Map<string | null, number>();
  for (const clientId of new Set(live.map((s) => s.clientId))) {
    const inForce = cards.filter((c) => c.clientId === clientId && c.billRate != null && c.effectiveFrom <= today && (c.effectiveTo === null || c.effectiveTo >= today));
    if (inForce.length) rateBy.set(clientId, inForce.reduce((sum, c) => sum + c.billRate!, 0) / inForce.length);
  }

  const stores: StaffingStore[] = live.map((s) => {
    const placed = placedBy.get(s.id) ?? 0;
    const defaults = new Map((targets.get(s.id) ?? []).map((d) => [d.week, d.day + d.evening + d.overnight]));
    const rate = rateBy.get(s.clientId) ?? null;
    return {
      storeId: s.id,
      storeName: s.name,
      clientId: s.clientId,
      clientName: s.client?.name ?? null,
      placed,
      weeks: weeks.map((week) => {
        const key = `${s.id}|${week}`;
        let source: DemandSource = 'none';
        let need = { heads: 0, hours: 0 };
        const fromSeason = season.get(key);
        const fromForecast = forecastBy.get(key);
        const fromTargets = defaults.get(week) ?? 0;
        if (fromSeason) {
          source = 'season';
          need = headsFor(fromSeason.daily, fromSeason.weekHours, fromSeason.shiftHours, fromSeason.reserve);
        } else if (fromForecast && fromForecast > 0) {
          source = 'forecast';
          need = { heads: Math.ceil((fromForecast / DEFAULT_WEEK_HOURS) * (1 + DEFAULT_RESERVE / 100)), hours: Math.round(fromForecast) };
        } else if (fromTargets > 0) {
          source = 'targets';
          need = headsFor(fromTargets, DEFAULT_WEEK_HOURS, DEFAULT_SHIFT_HOURS, DEFAULT_RESERVE);
        }
        const scheduled = scheduledBy.get(key)?.size ?? 0;
        return {
          week,
          required: need.heads,
          placed,
          scheduled,
          gap: Math.max(0, need.heads - placed),
          hours: need.hours,
          budget: rate !== null && need.hours > 0 ? Math.round(need.hours * rate) : null,
          source,
        };
      }),
    };
  });

  const totals = weeks.map((week, i) => {
    const ws = stores.map((st) => st.weeks[i]!);
    const priced = ws.filter((w) => w.budget !== null);
    return {
      week,
      required: ws.reduce((s, w) => s + w.required, 0),
      placed: ws.reduce((s, w) => s + w.placed, 0),
      scheduled: ws.reduce((s, w) => s + w.scheduled, 0),
      gap: ws.reduce((s, w) => s + w.gap, 0),
      budget: priced.length ? priced.reduce((s, w) => s + w.budget!, 0) : null,
    };
  });
  return { weeks, stores, totals, priced: stores.filter((st) => rateBy.has(st.clientId)).length };
}
