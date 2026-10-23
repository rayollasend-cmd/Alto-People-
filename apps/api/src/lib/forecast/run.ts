import type { Prisma, PrismaClient } from '@prisma/client';
import {
  FORECAST_HORIZON_WEEKS,
  FORECAST_METHOD,
  type ForecastAccuracyRow,
  type ForecastDrivers,
  type ForecastPlanInput,
  type ForecastResponse,
  type ForecastSignalKind,
  type ForecastSiteSummary,
  type ForecastSitesResponse,
  type ForecastWeek,
  type SeasonDemandWeek,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../../db.js';
import { HttpError } from '../../middleware/error.js';
import { createPlan, defaultDemandFor, seasonWeeks } from '../seasonPlanner.js';
import { dateKeyInZone, startOfWeekForSite } from '../timeAnomalies.js';
import { DEFAULT_TIMEZONE } from '../timezone.js';
import { ALTO_TENANT_ID, currentTenantId } from '../tenant.js';
import { addWeeks, backtest, DEFAULT_WEIGHTS, forecastSite, weeksBetween, type SignalRow, type WeekSeries, type Weights } from './model.js';

/**
 * Brief 3-4 — the forecast against the database: verified hours by site and
 * org week, a run that stores every site-week with its band and drivers, the
 * monthly scoring that turns past runs into accuracy rows and new weights,
 * and the one-click handoff into the season planner.
 */

type Db = PrismaClient;

const HISTORY_WEEKS = 60;
const DAY_MS = 86_400_000;
const atUtc = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);

interface SiteRow {
  id: string;
  name: string;
  timezone: string | null;
  clientId: string | null;
  client: { name: string } | null;
}

async function activeSites(db: Db, tenantId: string, locationIds?: string[] | null): Promise<SiteRow[]> {
  return db.site.findMany({
    where: { tenantId, isActive: true, deletedAt: null, ...(locationIds?.length ? { id: { in: locationIds } } : {}) },
    select: { id: true, name: true, timezone: true, clientId: true, client: { select: { name: true } } },
    orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
    take: 200,
  });
}

/**
 * Verified hours per site per org week (the week as the site sees it, keyed
 * by its site-local start day): approved and completed entries with both
 * punches, the hours of each entry on the week its clock-in falls in.
 */
export async function verifiedHoursBySite(
  db: Db,
  sites: readonly SiteRow[],
  from: Date,
  to: Date,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const tzOf = new Map(sites.map((s) => [s.id, s.timezone ?? DEFAULT_TIMEZONE]));
  for (const s of sites) out.set(s.id, new Map());
  if (!sites.length) return out;
  const rows = await db.timeEntry.findMany({
    where: {
      locationId: { in: sites.map((s) => s.id) },
      status: { in: ['APPROVED', 'COMPLETED'] },
      clockOutAt: { not: null },
      clockInAt: { gte: from, lt: to },
    },
    select: { locationId: true, clockInAt: true, clockOutAt: true },
  });
  for (const r of rows) {
    if (!r.locationId || !r.clockOutAt) continue;
    const tz = tzOf.get(r.locationId) ?? DEFAULT_TIMEZONE;
    const week = dateKeyInZone(startOfWeekForSite(r.clockInAt, tz), tz);
    const hours = Math.max(0, (r.clockOutAt.getTime() - r.clockInAt.getTime()) / 3_600_000);
    const series = out.get(r.locationId)!;
    series.set(week, (series.get(week) ?? 0) + hours);
  }
  // A week inside the covered range with no entry is a true zero, not a gap.
  for (const s of sites) {
    const tz = s.timezone ?? DEFAULT_TIMEZONE;
    const series = out.get(s.id)!;
    const first = dateKeyInZone(startOfWeekForSite(from, tz), tz);
    const last = dateKeyInZone(startOfWeekForSite(new Date(to.getTime() - DAY_MS), tz), tz);
    for (let w = first; w <= last; w = addWeeks(w, 1)) if (!series.has(w)) series.set(w, 0);
  }
  return out;
}

/** The org week (site-local start day) that contains `now` for a site. */
export function anchorWeekFor(now: Date, timezone: string | null): string {
  const tz = timezone ?? DEFAULT_TIMEZONE;
  return dateKeyInZone(startOfWeekForSite(now, tz), tz);
}

/** The site's first week with verified hours, or null when it has none in the range. */
export function firstVerifiedWeek(series: ReadonlyMap<string, number>): string | null {
  let first: string | null = null;
  for (const [k, v] of series) if (v > 0 && (first === null || k < first)) first = k;
  return first;
}

/**
 * Drop the weeks that have not finished yet so the model never reads a half
 * week as a low — and the weeks before the site's first verified hours: a
 * site that opened nine weeks ago has nine weeks of history, not 51 weeks
 * of zeros pulling its recent level and trend down. After the first week,
 * a week with no entry is a true zero.
 */
function completedOnly(series: Map<string, number>, anchor: string): WeekSeries {
  const first = firstVerifiedWeek(series);
  const out = new Map<string, number>();
  if (first === null) return out;
  for (const [k, v] of series) if (k < anchor && k >= first) out.set(k, v);
  return out;
}

async function signalsFor(db: Db, tenantId: string, locationIds: string[]): Promise<Map<string, SignalRow[]>> {
  const rows = await db.forecastSignal.findMany({ where: { tenantId, locationId: { in: locationIds } }, select: { locationId: true, weekStart: true, kind: true, factor: true, source: true } });
  const out = new Map<string, SignalRow[]>();
  for (const r of rows) {
    const list = out.get(r.locationId) ?? [];
    list.push({ weekStart: keyOf(r.weekStart), kind: r.kind as ForecastSignalKind, factor: r.factor, source: r.source });
    out.set(r.locationId, list);
  }
  return out;
}

export interface RunOpts {
  tenantId?: string;
  trigger: 'manual' | 'monthly' | 'backtest';
  createdById?: string | null;
  now?: Date;
  locationIds?: string[] | null;
}

export interface RunResult {
  runId: string;
  sites: number;
  weeks: number;
  weights: Weights & { mapePct: number | null; summerMapePct: number | null; scoredWeeks: number };
}

/**
 * Compute and store a run for the tenant: the back-test on the sites'
 * history picks the weights, then every site gets its 26 weeks.
 */
export async function computeForecastRun(db: Db, opts: RunOpts): Promise<RunResult> {
  const tenantId = opts.tenantId ?? currentTenantId() ?? ALTO_TENANT_ID;
  const now = opts.now ?? new Date();
  const sites = await activeSites(db, tenantId, opts.locationIds);
  const from = new Date(now.getTime() - (HISTORY_WEEKS + 1) * 7 * DAY_MS);
  const history = await verifiedHoursBySite(db, sites, from, now);
  const anchors = new Map(sites.map((s) => [s.id, anchorWeekFor(now, s.timezone)]));
  const completed = new Map<string, WeekSeries>();
  for (const s of sites) completed.set(s.id, completedOnly(history.get(s.id)!, anchors.get(s.id)!));
  const bt = backtest(completed);
  const weights = bt.scoredWeeks ? bt.weights : DEFAULT_WEIGHTS;
  const signals = await signalsFor(db, tenantId, sites.map((s) => s.id));
  // The run's anchor is the org week in the company zone; each site forecasts from its own.
  const anchorWeek = sites.length ? [...anchors.values()].sort()[0]! : anchorWeekFor(now, null);
  const run = await db.forecastRun.create({
    data: {
      tenantId,
      method: FORECAST_METHOD,
      horizonWeeks: FORECAST_HORIZON_WEEKS,
      anchorWeek: atUtc(anchorWeek),
      trigger: opts.trigger,
      createdById: opts.createdById ?? null,
      weights: { ...weights, mapePct: bt.mapePct, summerMapePct: bt.summerMapePct, scoredWeeks: bt.scoredWeeks } as Prisma.InputJsonObject,
    },
    select: { id: true },
  });
  const rows: Prisma.ForecastSiteWeekCreateManyInput[] = [];
  for (const s of sites) {
    const points = forecastSite(completed.get(s.id)!, { anchor: anchors.get(s.id)!, horizonWeeks: FORECAST_HORIZON_WEEKS, weights, signals: signals.get(s.id) ?? [] });
    for (const p of points) {
      rows.push({ tenantId, runId: run.id, locationId: s.id, weekStart: atUtc(p.weekStart), p10: p.p10, p50: p.p50, p90: p.p90, drivers: p.drivers as unknown as Prisma.InputJsonObject });
    }
  }
  if (rows.length) await db.forecastSiteWeek.createMany({ data: rows });
  return { runId: run.id, sites: sites.length, weeks: rows.length, weights: { ...weights, mapePct: bt.mapePct, summerMapePct: bt.summerMapePct, scoredWeeks: bt.scoredWeeks } };
}

/**
 * The monthly scoring: every site-week a past run forecast whose week has
 * ended is compared with the verified hours that came, one row per lead.
 * The next run's back-test then re-picks the weights from the history, so
 * the model improves as the months go by.
 */
export async function scoreForecastAccuracy(db: Db, opts: { tenantId?: string; now?: Date } = {}): Promise<{ scored: number }> {
  const tenantId = opts.tenantId ?? currentTenantId() ?? ALTO_TENANT_ID;
  const now = opts.now ?? new Date();
  const sites = await activeSites(db, tenantId);
  const anchors = new Map(sites.map((s) => [s.id, anchorWeekFor(now, s.timezone)]));
  const since = new Date(now.getTime() - 400 * DAY_MS);
  const history = await verifiedHoursBySite(db, sites, since, now);
  const forecasts = await db.forecastSiteWeek.findMany({
    where: { tenantId, weekStart: { gte: since, lt: now }, run: { trigger: { not: 'backtest' } } },
    select: { runId: true, locationId: true, weekStart: true, p50: true, drivers: true },
    orderBy: { run: { generatedAt: 'asc' } },
  });
  let scored = 0;
  for (const f of forecasts) {
    const week = keyOf(f.weekStart);
    const anchor = anchors.get(f.locationId);
    if (!anchor || week >= anchor) continue; // not finished yet
    const actual = history.get(f.locationId)?.get(week);
    if (actual === undefined || actual <= 0) continue;
    const lead = Number((f.drivers as Partial<ForecastDrivers> | null)?.leadWeeks ?? 0) || Math.max(1, weeksBetween(anchor, week) + 1);
    const absPctError = Math.round((Math.abs(f.p50 - actual) / actual) * 1000) / 10;
    await db.forecastAccuracy.upsert({
      where: { locationId_weekStart_leadWeeks: { locationId: f.locationId, weekStart: f.weekStart, leadWeeks: lead } },
      create: { tenantId, locationId: f.locationId, weekStart: f.weekStart, leadWeeks: lead, forecastP50: f.p50, actualHours: actual, absPctError, runId: f.runId },
      update: { forecastP50: f.p50, actualHours: actual, absPctError, runId: f.runId, recordedAt: now },
    });
    scored += 1;
  }
  return { scored };
}

/** Once a month per tenant: score what came true, then compute the next run. */
export async function monthlyForecastSweep(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<{ ran: boolean; scored: number }> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const already = await db.forecastRun.count({ where: { tenantId, trigger: { in: ['monthly', 'manual'] }, generatedAt: { gte: monthStart } } });
  if (already) return { ran: false, scored: 0 };
  const { scored } = await scoreForecastAccuracy(db, { tenantId, now });
  await computeForecastRun(db, { tenantId, trigger: 'monthly', now });
  return { ran: true, scored };
}

/* ------------------------------------------------------------- reads */

const RUN_SELECT = { id: true, method: true, generatedAt: true, anchorWeek: true, horizonWeeks: true, trigger: true, weights: true } as const;
type RunRow = Prisma.ForecastRunGetPayload<{ select: typeof RUN_SELECT }>;

function shapeRun(r: RunRow | null): ForecastResponse['run'] {
  if (!r) return null;
  const w = (r.weights ?? {}) as Partial<Weights>;
  return {
    id: r.id,
    method: r.method,
    generatedAt: r.generatedAt.toISOString(),
    anchorWeek: keyOf(r.anchorWeek),
    horizonWeeks: r.horizonWeeks,
    trigger: r.trigger,
    weights: { lastYearWeight: w.lastYearWeight ?? DEFAULT_WEIGHTS.lastYearWeight, bandLow: w.bandLow ?? DEFAULT_WEIGHTS.bandLow, bandHigh: w.bandHigh ?? DEFAULT_WEIGHTS.bandHigh },
  };
}

async function latestRun(db: Db, tenantId: string): Promise<RunRow | null> {
  return db.forecastRun.findFirst({ where: { tenantId, trigger: { not: 'backtest' } }, orderBy: { generatedAt: 'desc' }, select: RUN_SELECT });
}

async function siteSummaries(db: Db, tenantId: string, sites: readonly SiteRow[], run: RunRow | null, now: Date): Promise<ForecastSiteSummary[]> {
  const ids = sites.map((s) => s.id);
  const next4 = new Map<string, number>();
  if (run && ids.length) {
    const rows = await db.forecastSiteWeek.findMany({ where: { runId: run.id, locationId: { in: ids } }, select: { locationId: true, weekStart: true, p50: true, drivers: true } });
    for (const r of rows) {
      const lead = Number((r.drivers as Partial<ForecastDrivers> | null)?.leadWeeks ?? 99);
      if (lead <= 4) next4.set(r.locationId, (next4.get(r.locationId) ?? 0) + r.p50);
    }
  }
  const mape = new Map<string, { sum: number; n: number }>();
  if (ids.length) {
    const acc = await db.forecastAccuracy.findMany({ where: { tenantId, locationId: { in: ids }, leadWeeks: 4 }, select: { locationId: true, absPctError: true } });
    for (const a of acc) {
      const m = mape.get(a.locationId) ?? { sum: 0, n: 0 };
      m.sum += a.absPctError;
      m.n += 1;
      mape.set(a.locationId, m);
    }
  }
  const since = new Date(now.getTime() - (HISTORY_WEEKS + 1) * 7 * DAY_MS);
  const history = await verifiedHoursBySite(db, sites, since, now);
  return sites.map((s) => {
    const m = mape.get(s.id);
    const series = history.get(s.id)!;
    const anchor = anchorWeekFor(now, s.timezone);
    let historyWeeks = 0;
    for (const [k, v] of series) if (k < anchor && v > 0) historyWeeks += 1;
    return {
      locationId: s.id,
      siteName: s.name,
      clientName: s.client?.name ?? null,
      timezone: s.timezone ?? DEFAULT_TIMEZONE,
      next4WeeksHours: Math.round((next4.get(s.id) ?? 0) * 10) / 10,
      mapePct: m && m.n ? Math.round((m.sum / m.n) * 10) / 10 : null,
      historyWeeks,
    };
  });
}

export async function forecastSites(db: Db, opts: { tenantId?: string; now?: Date } = {}): Promise<ForecastSitesResponse> {
  const tenantId = opts.tenantId ?? currentTenantId() ?? ALTO_TENANT_ID;
  const now = opts.now ?? new Date();
  const sites = await activeSites(db, tenantId);
  const run = await latestRun(db, tenantId);
  return { run: shapeRun(run), sites: await siteSummaries(db, tenantId, sites, run, now) };
}

export async function forecastForSite(db: Db, locationId: string, opts: { tenantId?: string; now?: Date } = {}): Promise<ForecastResponse> {
  const tenantId = opts.tenantId ?? currentTenantId() ?? ALTO_TENANT_ID;
  const now = opts.now ?? new Date();
  const [site] = await activeSites(db, tenantId, [locationId]);
  if (!site) throw new HttpError(404, 'site_not_found', 'That site does not exist.');
  const run = await latestRun(db, tenantId);
  const anchor = anchorWeekFor(now, site.timezone);
  const since = new Date(now.getTime() - (FORECAST_HORIZON_WEEKS + 1) * 7 * DAY_MS);
  const history = (await verifiedHoursBySite(db, [site], since, now)).get(site.id)!;
  const forecastRows = run
    ? await db.forecastSiteWeek.findMany({ where: { runId: run.id, locationId: site.id }, orderBy: { weekStart: 'asc' }, select: { weekStart: true, p10: true, p50: true, p90: true, drivers: true } })
    : [];
  const weeks: ForecastWeek[] = [];
  // The chart starts where the site's history does: weeks before its first
  // verified hours are not a real zero, so they are not drawn as one.
  const firstWeek = firstVerifiedWeek(history);
  const pastKeys = firstWeek === null ? [] : [...history.keys()].filter((k) => k < anchor && k >= firstWeek).sort().slice(-FORECAST_HORIZON_WEEKS);
  const emptyDrivers: ForecastDrivers = { lastYearScaled: null, recentMean: 0, trendPerWeek: 0, holidayFactor: 1, holidayName: null, signalFactor: 1, signals: [], lastYearWeight: 0, leadWeeks: 0 };
  const forecastByWeek = new Map(forecastRows.map((r) => [keyOf(r.weekStart), r]));
  for (const k of pastKeys) {
    const f = forecastByWeek.get(k);
    weeks.push({ weekStart: k, p10: f?.p10 ?? 0, p50: f?.p50 ?? 0, p90: f?.p90 ?? 0, actualHours: Math.round(history.get(k)! * 10) / 10, drivers: (f?.drivers as unknown as ForecastDrivers | null) ?? emptyDrivers });
  }
  for (const r of forecastRows) {
    const k = keyOf(r.weekStart);
    if (k < anchor) continue;
    weeks.push({ weekStart: k, p10: r.p10, p50: r.p50, p90: r.p90, actualHours: null, drivers: r.drivers as unknown as ForecastDrivers });
  }
  const accuracyRows = await db.forecastAccuracy.findMany({ where: { tenantId, locationId: site.id }, orderBy: [{ weekStart: 'desc' }, { leadWeeks: 'asc' }], take: 60, select: { weekStart: true, leadWeeks: true, forecastP50: true, actualHours: true, absPctError: true } });
  const accuracy: ForecastAccuracyRow[] = accuracyRows.map((a) => ({ weekStart: keyOf(a.weekStart), leadWeeks: a.leadWeeks, forecastP50: a.forecastP50, actualHours: Math.round(a.actualHours * 10) / 10, absPctError: a.absPctError }));
  const signalRows = await db.forecastSignal.findMany({ where: { tenantId, locationId: site.id }, orderBy: { weekStart: 'asc' }, select: { id: true, weekStart: true, kind: true, factor: true, source: true, note: true } });
  const [summary] = await siteSummaries(db, tenantId, [site], run, now);
  return {
    run: shapeRun(run),
    site: summary ?? null,
    weeks,
    accuracy,
    signals: signalRows.map((s) => ({ id: s.id, weekStart: keyOf(s.weekStart), kind: s.kind as ForecastSignalKind, factor: s.factor, source: s.source, note: s.note })),
  };
}

/* ------------------------------------------------------------- planner */

/**
 * One click: a season plan whose demand is the forecast. Hours a week
 * become people on the floor a day (hours ÷ 7 ÷ shift hours), split across
 * day, evening and overnight the way the site's current targets split, or
 * all on the day shift when it has none. Weeks past the horizon repeat the
 * last forecast week, and the plan says so in its notes.
 */
export async function planFromForecast(db: Db, input: ForecastPlanInput, actorUserId: string, opts: { tenantId?: string; now?: Date } = {}) {
  const tenantId = opts.tenantId ?? currentTenantId() ?? ALTO_TENANT_ID;
  const now = opts.now ?? new Date();
  const run = await latestRun(db, tenantId);
  if (!run) throw new HttpError(409, 'no_forecast', 'Compute a forecast first.');
  const sites = (await activeSites(db, tenantId)).filter((s) => s.clientId && (!input.clientId || s.clientId === input.clientId));
  if (!sites.length) throw new HttpError(400, 'no_sites', 'No active client site to plan for.');
  const weeks = seasonWeeks(input.seasonStart, input.seasonEnd);
  const shares = await defaultDemandFor(db, sites.map((s) => s.id), weeks.slice(0, 1));
  const rows = await db.forecastSiteWeek.findMany({ where: { runId: run.id, locationId: { in: sites.map((s) => s.id) } }, select: { locationId: true, weekStart: true, p50: true }, orderBy: { weekStart: 'asc' } });
  const bySite = new Map<string, Array<{ week: string; p50: number }>>();
  for (const r of rows) {
    const list = bySite.get(r.locationId) ?? [];
    list.push({ week: keyOf(r.weekStart), p50: r.p50 });
    bySite.set(r.locationId, list);
  }
  let beyondHorizon = 0;
  const planSites = sites.map((s) => {
    const fc = bySite.get(s.id) ?? [];
    const last = fc[fc.length - 1];
    const share = shares.get(s.id)?.[0] ?? { week: '', day: 0, evening: 0, overnight: 0 };
    const total = share.day + share.evening + share.overnight;
    const demand: SeasonDemandWeek[] = weeks.map((week) => {
      const hit = fc.find((f) => f.week === week);
      if (!hit && last && week > last.week) beyondHorizon += 1;
      const hours = hit?.p50 ?? (week > (last?.week ?? '') ? last?.p50 ?? 0 : 0);
      const daily = hours / 7 / input.shiftHours;
      const split = (part: number) => Math.round(total > 0 ? (daily * part) / total : 0);
      return total > 0
        ? { week, day: split(share.day), evening: split(share.evening), overnight: split(share.overnight) }
        : { week, day: Math.round(daily), evening: 0, overnight: 0 };
    });
    return { locationId: s.id, bedsAvailable: 0, vanSeatsPerRun: 14, runsPerShift: 1, routeMinutes: 45, demand, taskDemand: [] };
  });
  const note = `Demand from the forecast run of ${keyOf(run.generatedAt)} (${run.method}).${beyondHorizon ? ` ${beyondHorizon} site-week${beyondHorizon === 1 ? '' : 's'} past the 26-week horizon repeat the last forecast week.` : ''}`;
  return createPlan(
    db,
    {
      name: input.name,
      clientId: input.clientId ?? null,
      seasonStart: input.seasonStart,
      seasonEnd: input.seasonEnd,
      targetHoursPerWeek: input.targetHoursPerWeek,
      shiftHours: input.shiftHours,
      reservePct: input.reservePct,
      notes: note,
      sites: planSites,
    },
    actorUserId,
    now,
  );
}
