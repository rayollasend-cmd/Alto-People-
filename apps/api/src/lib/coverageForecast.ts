import type { Prisma, PrismaClient } from '@prisma/client';
import { capabilityDef } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { EMPLOYED_WHERE } from './activeDefinition.js';
import { inProcessAgent, logAgentAction } from './agents.js';
import { registerCapabilityMetrics, registerCapabilityRunner } from './agentCapabilities.js';
import { benchFor } from './scope.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';
import { moduleOn } from './tenantProfile.js';
import { companyWorkweek, dateKeyInZone, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { addDaysToKey, dateColumnKey } from './timezone.js';
import { WORKFORCE_AGENT_KEY } from './workforceAgent.js';

/**
 * The Workforce agent's `coverage.forecast` (agent families step 3;
 * docs/agent-families-investigation.md §4).
 *
 *   For every site with a staffing target, today and the next seven days
 *   (site-local): the headcount the targets call for (the shift windows'
 *   sum, else the site total; effective-dated per window, newest wins, as
 *   the live floor reads it), the distinct people on assigned published
 *   shifts, the published shifts still open, the free bench (the site's
 *   bench as shift.fill reads it, employed, with no shift that day) and the
 *   gap. Read only: it proposes nothing.
 *
 *   Once a day the rows are written (CoverageForecastDay, never updated).
 *   The relay board reads the latest as one baton to the Workforce desk;
 *   the season planner reads them as the near-term actuals; the scorecard
 *   compares what was forecast 7 and 1 days ahead with the day itself; Hugo
 *   answers "how is coverage" from a fresh computation, never a stale row.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const COVERAGE_FORECAST = 'coverage.forecast';
const DAY_MS = 86_400_000;
/** Today (lead 0) and the next seven days. */
export const FORECAST_LEADS = 7;

export interface ForecastDay {
  /** Site-local YYYY-MM-DD. */
  date: string;
  leadDays: number;
  demand: number;
  assigned: number;
  openShifts: number;
  bench: number;
  gap: number;
}

export interface ForecastSite {
  locationId: string;
  name: string;
  timezone: string;
  clientId: string | null;
  days: ForecastDay[];
}

type TargetRow = { locationId: string; label: string | null; targetCount: number; effectiveFrom: Date };

/** The headcount a site's targets call for on a site-local day (windows summed, else the total). */
export function demandOn(targets: readonly TargetRow[], dayKey: string): number | null {
  const newest = new Map<string, TargetRow>();
  for (const t of targets) {
    if (dateColumnKey(t.effectiveFrom) > dayKey) continue;
    const k = t.label ?? '';
    const cur = newest.get(k);
    if (!cur || cur.effectiveFrom < t.effectiveFrom) newest.set(k, t);
  }
  const windows = [...newest.entries()].filter(([k]) => k !== '').map(([, t]) => t.targetCount);
  if (windows.length) return windows.reduce((a, b) => a + b, 0);
  const total = newest.get('');
  return total ? total.targetCount : null;
}

function dayKeys(now: Date, tz: string): string[] {
  const first = dateKeyInZone(now, tz);
  const out: string[] = [];
  for (let i = 0; i <= FORECAST_LEADS; i++) out.push(addDaysToKey(first, i));
  return out;
}

/**
 * The forecast, computed now. `locationIds` narrows it (a bounded desk);
 * sites without any staffing target are left out (no demand to compare).
 */
export async function computeCoverageForecast(db: Db, now: Date, opts: { tenantId: string; locationIds?: string[] | null; clientId?: string | null }): Promise<ForecastSite[]> {
  const targets = await db.staffingTarget.findMany({
    where: {
      tenantId: opts.tenantId,
      effectiveFrom: { lte: new Date(now.getTime() + (FORECAST_LEADS + 1) * DAY_MS) },
      ...(opts.locationIds ? { locationId: { in: opts.locationIds } } : {}),
      location: { deletedAt: null, ...(opts.clientId ? { clientId: opts.clientId } : {}) },
    },
    select: { locationId: true, label: true, targetCount: true, effectiveFrom: true },
  });
  if (!targets.length) return [];
  const siteIds = [...new Set(targets.map((t) => t.locationId))];
  const sites = await db.site.findMany({ where: { id: { in: siteIds }, tenantId: opts.tenantId, deletedAt: null }, select: { id: true, name: true, timezone: true, clientId: true }, orderBy: { name: 'asc' } });
  const out: ForecastSite[] = [];
  for (const site of sites) {
    const tz = site.timezone ?? companyWorkweek().timezone;
    const keys = dayKeys(now, tz);
    const starts = keys.map((k) => utcInstantOfLocalMidnight(k, tz));
    const end = utcInstantOfLocalMidnight(addDaysToKey(keys[keys.length - 1]!, 1), tz);
    const shifts = await db.shift.findMany({
      where: { tenantId: opts.tenantId, locationId: site.id, publishedAt: { not: null }, status: { in: ['OPEN', 'ASSIGNED'] }, startsAt: { gte: starts[0]!, lt: end } },
      select: { startsAt: true, status: true, assignedAssociateId: true },
    });
    const bench = benchFor({ clientId: site.clientId, locationId: site.id });
    const people = bench
      ? await db.associate.findMany({ where: { tenantId: opts.tenantId, ...EMPLOYED_WHERE, AND: [bench] }, select: { id: true }, take: 2_000 })
      : [];
    const benchIds = people.map((p) => p.id);
    // Anyone on the bench with any shift (anywhere) that day is not free.
    const busy = benchIds.length
      ? await db.shift.findMany({
          where: { assignedAssociateId: { in: benchIds }, status: { notIn: ['CANCELLED'] }, startsAt: { lt: end }, endsAt: { gt: starts[0]! } },
          select: { assignedAssociateId: true, startsAt: true, endsAt: true },
        })
      : [];
    const siteTargets = targets.filter((t) => t.locationId === site.id);
    const days: ForecastDay[] = [];
    keys.forEach((key, i) => {
      const demand = demandOn(siteTargets, key);
      if (demand === null) return;
      const from = starts[i]!;
      const to = i + 1 < starts.length ? starts[i + 1]! : end;
      const inDay = shifts.filter((s) => s.startsAt >= from && s.startsAt < to);
      const assigned = new Set(inDay.filter((s) => s.status === 'ASSIGNED' && s.assignedAssociateId).map((s) => s.assignedAssociateId!)).size;
      const busyThatDay = new Set(busy.filter((s) => s.startsAt < to && s.endsAt > from).map((s) => s.assignedAssociateId!));
      days.push({
        date: key,
        leadDays: i,
        demand,
        assigned,
        openShifts: inDay.filter((s) => s.status === 'OPEN').length,
        bench: benchIds.filter((id) => !busyThatDay.has(id)).length,
        gap: Math.max(0, demand - assigned),
      });
    });
    if (days.length) out.push({ locationId: site.id, name: site.name, timezone: tz, clientId: site.clientId, days });
  }
  return out;
}

export interface CoverageForecastRun {
  sites: number;
  written: number;
  shortDays: number;
  skipped?: 'module_off' | 'agent_stopped' | 'capability_off';
}

/** Is the capability running for this tenant (module, agent, capability)? The agent, or why not. */
export async function forecastAgent(db: Db, tenantId: string) {
  for (const m of capabilityDef(COVERAGE_FORECAST)!.requiresModule) {
    if (!(await moduleOn(m, tenantId))) return 'module_off' as const;
  }
  const agent = await inProcessAgent(db, WORKFORCE_AGENT_KEY, tenantId);
  if (!agent) return 'agent_stopped' as const;
  const cap = await db.agentCapability.findFirst({ where: { workerId: agent.workerId, key: COVERAGE_FORECAST, tenantId } });
  if (!cap || !cap.enabled || cap.suspendedAt) return 'capability_off' as const;
  return agent;
}

/**
 * The daily write, for the tenant in context: once per site per site-local
 * day (the unique row is the claim; a second tick that day writes nothing).
 */
export async function runCoverageForecast(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<CoverageForecastRun> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: CoverageForecastRun = { sites: 0, written: 0, shortDays: 0 };
  const agent = await forecastAgent(db, tenantId);
  if (typeof agent === 'string') return { ...out, skipped: agent };
  // The tick runs every fifteen minutes: compute only for sites still without today's rows.
  const withTargets = await db.staffingTarget.findMany({ where: { tenantId, location: { deletedAt: null } }, select: { locationId: true, location: { select: { timezone: true } } }, distinct: ['locationId'] });
  const due: string[] = [];
  for (const t of withTargets) {
    const forecastOn = new Date(`${dateKeyInZone(now, t.location.timezone ?? companyWorkweek().timezone)}T00:00:00Z`);
    if (!(await db.coverageForecastDay.count({ where: { locationId: t.locationId, forecastOn } }))) due.push(t.locationId);
  }
  if (!due.length) return out;
  const forecast = await computeCoverageForecast(db, now, { tenantId, locationIds: due });
  for (const site of forecast) {
    const forecastOn = new Date(`${site.days[0]!.date}T00:00:00Z`);
    const already = await db.coverageForecastDay.count({ where: { locationId: site.locationId, forecastOn } });
    if (already) continue;
    const r = await db.coverageForecastDay.createMany({
      data: site.days.map((d) => ({
        tenantId,
        locationId: site.locationId,
        forecastOn,
        targetDay: new Date(`${d.date}T00:00:00Z`),
        leadDays: d.leadDays,
        demand: d.demand,
        assigned: d.assigned,
        openShifts: d.openShifts,
        bench: d.bench,
        gap: d.gap,
      })),
      skipDuplicates: true,
    });
    out.sites += 1;
    out.written += r.count;
    out.shortDays += site.days.filter((d) => d.gap > 0).length;
  }
  if (out.written) {
    logAgentAction(agent, { action: 'agent.coverage.forecast', entityType: 'Tenant', entityId: tenantId, scopes: [...capabilityDef(COVERAGE_FORECAST)!.scopes], metadata: { sites: out.sites, rows: out.written, shortDays: out.shortDays } });
  }
  return out;
}

export interface CoverageGapSummary {
  /** Site-days short in the next seven days (today included). */
  shortDays: number;
  /** People short, summed over those days. */
  headsShort: number;
  /** The earliest short day and its site, for the deep link. */
  first: { date: string; locationId: string; name: string; gap: number } | null;
}

/**
 * The relay board's read: the latest forecast rows written for each site
 * (at most a day old), the days from today on. Null when the capability
 * has written nothing recent (it is off, or has not run): no baton then.
 */
export async function latestCoverageGaps(db: Db, now: Date, tenantId: string): Promise<CoverageGapSummary | null> {
  const since = new Date(now.getTime() - 2 * DAY_MS);
  const rows = await db.coverageForecastDay.findMany({
    where: { tenantId, forecastOn: { gte: since } },
    select: { locationId: true, forecastOn: true, targetDay: true, leadDays: true, gap: true, location: { select: { name: true, timezone: true } } },
    orderBy: [{ forecastOn: 'desc' }],
  });
  if (!rows.length) return null;
  const newest = new Map<string, Date>();
  for (const r of rows) if (!newest.has(r.locationId)) newest.set(r.locationId, r.forecastOn);
  const today = new Map<string, string>();
  const live = rows.filter((r) => {
    if (r.forecastOn.getTime() !== newest.get(r.locationId)!.getTime()) return false;
    const t = today.get(r.locationId) ?? dateKeyInZone(now, r.location.timezone ?? companyWorkweek().timezone);
    today.set(r.locationId, t);
    const day = dateColumnKey(r.targetDay);
    return day >= t && day < addDaysToKey(t, FORECAST_LEADS);
  });
  const short = live.filter((r) => r.gap > 0).sort((a, b) => a.targetDay.getTime() - b.targetDay.getTime() || b.gap - a.gap);
  const f = short[0];
  return {
    shortDays: short.length,
    headsShort: short.reduce((a, r) => a + r.gap, 0),
    first: f ? { date: dateColumnKey(f.targetDay), locationId: f.locationId, name: f.location.name, gap: f.gap } : null,
  };
}

/** Mean absolute error of `assigned`, forecast `lead` days ahead vs the day itself, in percent. */
async function forecastError(db: Db, tenantId: string, lead: number, since: Date): Promise<number | null> {
  const ahead = await db.coverageForecastDay.findMany({ where: { tenantId, leadDays: lead, targetDay: { gte: since } }, select: { locationId: true, targetDay: true, assigned: true } });
  if (!ahead.length) return null;
  const actual = await db.coverageForecastDay.findMany({
    where: { tenantId, leadDays: 0, targetDay: { in: [...new Set(ahead.map((a) => a.targetDay.getTime()))].map((t) => new Date(t)) } },
    select: { locationId: true, targetDay: true, assigned: true },
  });
  const byKey = new Map(actual.map((a) => [`${a.locationId}|${a.targetDay.getTime()}`, a.assigned]));
  const errs: number[] = [];
  for (const a of ahead) {
    const real = byKey.get(`${a.locationId}|${a.targetDay.getTime()}`);
    if (real === undefined) continue;
    errs.push(Math.abs(a.assigned - real) / Math.max(real, 1));
  }
  return errs.length ? Math.round((errs.reduce((x, y) => x + y, 0) / errs.length) * 100) : null;
}

let registered = false;

/** Idempotent: wire coverage.forecast's fixture runner and metrics (no executor: it proposes nothing). */
export function registerCoverageForecast(): void {
  if (registered) return;
  registered = true;
  // The site short tomorrow, by the real computation.
  registerCapabilityRunner(COVERAGE_FORECAST, async (ctx) => {
    const forecast = await computeCoverageForecast(ctx.db, ctx.now, { tenantId: ctx.tenantId });
    const tomorrow = forecast
      .map((s) => ({ s, d: s.days.find((d) => d.leadDays === 1) }))
      .filter((x) => x.d && x.d.gap > 0)
      .sort((a, b) => b.d!.gap - a.d!.gap);
    const top = tomorrow[0];
    return { output: { shortRef: top?.s.locationId ?? null, gap: top?.d!.gap ?? 0 }, actions: [] };
  });
  registerCapabilityMetrics(COVERAGE_FORECAST, async (db, workerId, since) => {
    const worker = await db.worker.findUnique({ where: { id: workerId }, select: { tenantId: true } });
    const tenantId = worker?.tenantId ?? ALTO_TENANT_ID;
    return {
      forecastErrorPct7d: await forecastError(db, tenantId, 7, since),
      forecastErrorPct1d: await forecastError(db, tenantId, 1, since),
    };
  });
}

registerCoverageForecast();
