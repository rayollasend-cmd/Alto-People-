import type { Prisma, PrismaClient } from '@prisma/client';
import {
  RECRUITING_CHANNELS,
  RECRUITING_CHANNEL_LABELS,
  type ChannelPercent,
  type ChannelWeeks,
  type RecruitingChannel,
  type SeasonDemandWeek,
  type SeasonGap,
  type SeasonPlanComputed,
  type SeasonPlanInput,
  type SeasonPlanSiteComputed,
  type SeasonPlanSiteInput,
  type SeasonPlanSiteWeek,
  type SeasonPlanSummary,
  type SeasonPlanUpdate,
  type SeasonRecruitingTarget,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { activeAssociateIds } from './activeDefinition.js';
import { currentStoreWindows } from './shiftWindows.js';
import { orgDateKey, startOfWeekUTC } from './timeAnomalies.js';

/**
 * THE SEASON PLANNER — demand becomes people, beds, seats and recruits.
 *
 * Inputs per store: headcount on the floor per shift (day, evening,
 * overnight) for each org week of the season; beds the store's people can
 * use; what the vans carry per run and how many runs a shift gets. Plan-
 * wide: the target week (40 h), the shift length (8 h), the reserve (10%),
 * and the recruiting mix by channel with each channel's lead time and
 * housing and ride shares.
 *
 * The arithmetic is deliberately plain and shown in full on the page:
 *
 *   shift slots in a week  = daily floor headcount × 7
 *   shifts one person works = target hours ÷ shift hours   (40 ÷ 8 = 5)
 *   associates needed      = ceil(slots ÷ shifts per person × (1 + reserve))
 *
 * so 400 on the floor a day → 2,800 slots → 560 people → 616 with reserve.
 * Beds and seats follow the channel mix (who needs housing, who rides);
 * recruiting targets split the peak need by channel and back each one off
 * the season start by its lead time. Gaps are every shortfall, named.
 */

type Db = PrismaClient;

const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const atUtc = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => ymd(new Date(atUtc(s).getTime() + n * DAY_MS));

const DEFAULT_MIX: ChannelPercent = { LOCAL: 25, J1_NORTH: 35, J1_SOUTH: 15, H2B: 25 };
const DEFAULT_LEAD: ChannelWeeks = { LOCAL: 3, J1_NORTH: 10, J1_SOUTH: 12, H2B: 20 };
const DEFAULT_HOUSING: ChannelPercent = { LOCAL: 0, J1_NORTH: 100, J1_SOUTH: 100, H2B: 100 };
const DEFAULT_RIDE: ChannelPercent = { LOCAL: 10, J1_NORTH: 100, J1_SOUTH: 100, H2B: 100 };

/** Countries whose university summer is the northern winter. */
const SOUTHERN_HEMISPHERE = new Set(
  ['argentina', 'australia', 'bolivia', 'botswana', 'brazil', 'chile', 'ecuador', 'fiji', 'indonesia', 'madagascar', 'malawi', 'mozambique', 'namibia', 'new zealand', 'papua new guinea', 'paraguay', 'peru', 'south africa', 'tanzania', 'uruguay', 'zambia', 'zimbabwe'],
);

function channels<T>(raw: unknown, fallback: T): T {
  if (!raw || typeof raw !== 'object') return fallback;
  const out = { ...fallback } as Record<string, number>;
  for (const c of RECRUITING_CHANNELS) {
    const v = (raw as Record<string, unknown>)[c];
    if (typeof v === 'number' && Number.isFinite(v)) out[c] = v;
  }
  return out as T;
}

/** Org weeks (Saturday starts, as YYYY-MM-DD) covering the season. */
export function seasonWeeks(seasonStart: string, seasonEnd: string): string[] {
  const out: string[] = [];
  let cursor = startOfWeekUTC(new Date(`${seasonStart}T12:00:00.000Z`));
  const end = new Date(`${seasonEnd}T12:00:00.000Z`);
  for (let i = 0; i < 60 && cursor.getTime() <= end.getTime(); i++) {
    out.push(orgDateKey(cursor));
    cursor = startOfWeekUTC(new Date(cursor.getTime() + 7 * DAY_MS + 12 * 3_600_000));
  }
  return out;
}

const PLAN_INCLUDE = {
  client: { select: { id: true, name: true } },
  sites: { include: { location: { select: { id: true, name: true, clientId: true, client: { select: { name: true } } } } }, orderBy: { location: { name: 'asc' } } },
} satisfies Prisma.SeasonPlanInclude;
type PlanRow = Prisma.SeasonPlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

function demandOf(raw: unknown): SeasonDemandWeek[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is SeasonDemandWeek => !!d && typeof d === 'object' && typeof (d as SeasonDemandWeek).week === 'string')
    .map((d) => ({ week: d.week, day: Number(d.day) || 0, evening: Number(d.evening) || 0, overnight: Number(d.overnight) || 0 }));
}

function summary(p: PlanRow): SeasonPlanSummary {
  const seasonStart = ymd(p.seasonStart);
  const seasonEnd = ymd(p.seasonEnd);
  return {
    id: p.id,
    name: p.name,
    clientId: p.client?.id ?? null,
    clientName: p.client?.name ?? null,
    seasonStart,
    seasonEnd,
    targetHoursPerWeek: p.targetHoursPerWeek,
    shiftHours: p.shiftHours,
    reservePct: p.reservePct,
    channelMix: channels(p.channelMix, DEFAULT_MIX),
    arrivalLeadWeeks: channels(p.arrivalLeadWeeks, DEFAULT_LEAD),
    housingShare: channels(p.housingShare, DEFAULT_HOUSING),
    rideShare: channels(p.rideShare, DEFAULT_RIDE),
    notes: p.notes,
    archivedAt: p.archivedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    siteCount: p.sites.length,
    weeks: seasonWeeks(seasonStart, seasonEnd),
  };
}

/**
 * Default demand for a store: its current labeled staffing targets, folded
 * into day / evening / overnight by start time, repeated for every week.
 * A store with only a total target puts it all on the day shift.
 */
export async function defaultDemandFor(db: Db, locationIds: string[], weeks: string[]): Promise<Map<string, SeasonDemandWeek[]>> {
  const windows = await currentStoreWindows(db, locationIds);
  const totals = await db.staffingTarget.findMany({
    where: { locationId: { in: locationIds }, label: null, effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: 'desc' },
    select: { locationId: true, targetCount: true },
  });
  const totalBy = new Map<string, number>();
  for (const t of totals) if (!totalBy.has(t.locationId)) totalBy.set(t.locationId, t.targetCount);
  const out = new Map<string, SeasonDemandWeek[]>();
  for (const locationId of locationIds) {
    let day = 0;
    let evening = 0;
    let overnight = 0;
    let any = false;
    for (const w of windows.values()) {
      if (w.locationId !== locationId) continue;
      any = true;
      if (w.startMinute < 11 * 60) day += w.targetCount;
      else if (w.startMinute < 20 * 60) evening += w.targetCount;
      else overnight += w.targetCount;
    }
    if (!any) day = totalBy.get(locationId) ?? 0;
    out.set(
      locationId,
      weeks.map((week) => ({ week, day, evening, overnight })),
    );
  }
  return out;
}

/* ------------------------------------------------------------- compute */

interface Actuals {
  scheduledHours: Map<string, number>; // `${locationId}|${week}`
  activeNow: Map<string, number>; // locationId
  currentWeek: string;
  /** coverage.forecast: short days per `${locationId}|${week}` from each site's latest forecast. */
  forecastShort: Map<string, number>;
}

async function actualsFor(db: Db, locationIds: string[], weeks: string[], now: Date): Promise<Actuals> {
  const currentWeek = orgDateKey(startOfWeekUTC(now));
  const scheduledHours = new Map<string, number>();
  const activeNow = new Map<string, number>();
  const forecastShort = new Map<string, number>();
  if (locationIds.length === 0 || weeks.length === 0) return { scheduledHours, activeNow, currentWeek, forecastShort };
  const first = atUtc(weeks[0]!);
  const last = new Date(atUtc(weeks[weeks.length - 1]!).getTime() + 8 * DAY_MS);
  const shifts = await db.shift.findMany({
    where: { locationId: { in: locationIds }, status: { notIn: ['CANCELLED', 'DRAFT'] }, startsAt: { gte: first, lt: last } },
    select: { locationId: true, startsAt: true, endsAt: true },
  });
  for (const s of shifts) {
    const week = orgDateKey(startOfWeekUTC(s.startsAt));
    const key = `${s.locationId}|${week}`;
    scheduledHours.set(key, (scheduledHours.get(key) ?? 0) + (s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000);
  }
  for (const locationId of locationIds) {
    activeNow.set(locationId, (await activeAssociateIds({ locationId }, now, db)).size);
  }
  // The Workforce agent's forecast (agent families step 3): each site's newest rows.
  const fc = await db.coverageForecastDay.findMany({
    where: { locationId: { in: locationIds }, forecastOn: { gte: new Date(now.getTime() - 2 * DAY_MS) } },
    select: { locationId: true, forecastOn: true, targetDay: true, gap: true },
    orderBy: { forecastOn: 'desc' },
  });
  const newest = new Map<string, number>();
  for (const r of fc) if (!newest.has(r.locationId)) newest.set(r.locationId, r.forecastOn.getTime());
  for (const r of fc) {
    if (r.forecastOn.getTime() !== newest.get(r.locationId)) continue;
    const key = `${r.locationId}|${orgDateKey(startOfWeekUTC(new Date(r.targetDay.getTime() + 12 * 3_600_000)))}`;
    forecastShort.set(key, (forecastShort.get(key) ?? 0) + (r.gap > 0 ? 1 : 0));
  }
  return { scheduledHours, activeNow, currentWeek, forecastShort };
}

function weightedShare(mix: ChannelPercent, share: ChannelPercent): number {
  let total = 0;
  let weighted = 0;
  for (const c of RECRUITING_CHANNELS) {
    total += mix[c];
    weighted += mix[c] * share[c];
  }
  return total > 0 ? weighted / total / 100 : 0;
}

async function pipelineByChannel(db: Db, p: PlanRow, locationIds: string[], now: Date): Promise<Record<RecruitingChannel, number>> {
  const out: Record<RecruitingChannel, number> = { LOCAL: 0, J1_NORTH: 0, J1_SOUTH: 0, H2B: 0 };
  const from = new Date(p.seasonStart.getTime() - 8 * 7 * DAY_MS);
  const programs = await db.program.findMany({
    where: { closedAt: null, programStart: { gte: from, lte: p.seasonEnd }, programEnd: { gte: p.seasonStart } },
    select: { associateId: true, type: true, country: true },
  });
  for (const pr of programs) {
    if (pr.type === 'H2B') out.H2B += 1;
    else if (pr.type === 'J1_SWT') {
      if (pr.country && SOUTHERN_HEMISPHERE.has(pr.country.trim().toLowerCase())) out.J1_SOUTH += 1;
      else out.J1_NORTH += 1;
    }
  }
  // Local pipeline: the people already active at these sites who are not
  // on a visa program.
  const onProgram = new Set(programs.map((pr) => pr.associateId));
  for (const locationId of locationIds) {
    const active = await activeAssociateIds({ locationId }, now, db);
    for (const id of active) if (!onProgram.has(id)) out.LOCAL += 1;
  }
  return out;
}

export async function computePlan(db: Db, p: PlanRow, now: Date = new Date()): Promise<SeasonPlanComputed> {
  const s = summary(p);
  const weeks = s.weeks;
  const shiftsPerPerson = Math.max(1, s.targetHoursPerWeek / s.shiftHours);
  const housing = weightedShare(s.channelMix, s.housingShare);
  const ride = weightedShare(s.channelMix, s.rideShare);
  const locationIds = p.sites.map((x) => x.locationId);
  const actuals = await actualsFor(db, locationIds, weeks, now);

  // A season plan is per client site; a client-less site (a direct employer) waits for step 5's org unit.
  const sites: SeasonPlanSiteComputed[] = p.sites.flatMap((site) => {
    const client = site.location.clientId && site.location.client ? { id: site.location.clientId, name: site.location.client.name } : null;
    if (!client) return [];
    const demand = new Map(demandOf(site.demand).map((d) => [d.week, d]));
    const seatsAvailable = site.vanSeatsPerRun * site.runsPerShift;
    const rows: SeasonPlanSiteWeek[] = weeks.map((week) => {
      const d = demand.get(week) ?? { week, day: 0, evening: 0, overnight: 0 };
      const daily = d.day + d.evening + d.overnight;
      const shiftSlots = daily * 7;
      const associatesNeeded = Math.ceil((shiftSlots / shiftsPerPerson) * (1 + s.reservePct / 100));
      const bedsNeeded = Math.ceil(associatesNeeded * housing);
      const vanSeatsNeeded = Math.ceil(Math.max(d.day, d.evening, d.overnight) * ride);
      const sched = actuals.scheduledHours.get(`${site.locationId}|${week}`);
      return {
        week,
        day: d.day,
        evening: d.evening,
        overnight: d.overnight,
        daily,
        shiftSlots,
        associatesNeeded,
        bedsNeeded,
        bedsAvailable: site.bedsAvailable,
        bedsGap: Math.max(0, bedsNeeded - site.bedsAvailable),
        vanSeatsNeeded,
        vanSeatsAvailable: seatsAvailable,
        vanSeatsGap: Math.max(0, vanSeatsNeeded - seatsAvailable),
        scheduledHours: sched !== undefined ? Math.round(sched * 10) / 10 : week <= actuals.currentWeek ? 0 : null,
        activeHeadcount: week === actuals.currentWeek ? (actuals.activeNow.get(site.locationId) ?? 0) : null,
        forecastShortDays: actuals.forecastShort.get(`${site.locationId}|${week}`) ?? null,
      };
    });
    const peakRow = rows.reduce((best, r) => (r.associatesNeeded > best.associatesNeeded ? r : best), rows[0] ?? { week: weeks[0] ?? s.seasonStart, daily: 0, associatesNeeded: 0, bedsNeeded: 0, vanSeatsNeeded: 0 });
    return [{
      locationId: site.locationId,
      siteName: site.location.name,
      clientId: client.id,
      clientName: client.name,
      bedsAvailable: site.bedsAvailable,
      vanSeatsPerRun: site.vanSeatsPerRun,
      runsPerShift: site.runsPerShift,
      routeMinutes: site.routeMinutes,
      weeks: rows,
      peak: { week: peakRow.week, daily: peakRow.daily, associatesNeeded: peakRow.associatesNeeded, bedsNeeded: peakRow.bedsNeeded, vanSeatsNeeded: peakRow.vanSeatsNeeded },
    }];
  });

  const totals = weeks.map((week, i) => {
    const rows = sites.map((x) => x.weeks[i]!);
    const anyActual = rows.some((r) => r.scheduledHours !== null);
    const anyActive = rows.some((r) => r.activeHeadcount !== null);
    const anyForecast = rows.some((r) => r.forecastShortDays != null);
    return {
      week,
      daily: rows.reduce((a, r) => a + r.daily, 0),
      associatesNeeded: rows.reduce((a, r) => a + r.associatesNeeded, 0),
      bedsNeeded: rows.reduce((a, r) => a + r.bedsNeeded, 0),
      bedsAvailable: rows.reduce((a, r) => a + r.bedsAvailable, 0),
      vanSeatsNeeded: rows.reduce((a, r) => a + r.vanSeatsNeeded, 0),
      vanSeatsAvailable: rows.reduce((a, r) => a + r.vanSeatsAvailable, 0),
      scheduledHours: anyActual ? Math.round(rows.reduce((a, r) => a + (r.scheduledHours ?? 0), 0) * 10) / 10 : null,
      activeHeadcount: anyActive ? rows.reduce((a, r) => a + (r.activeHeadcount ?? 0), 0) : null,
      forecastShortDays: anyForecast ? rows.reduce((a, r) => a + (r.forecastShortDays ?? 0), 0) : null,
    };
  });
  const peakTotal = totals.reduce((best, t) => (t.associatesNeeded > best.associatesNeeded ? t : best), totals[0] ?? { week: s.seasonStart, daily: 0, associatesNeeded: 0, bedsNeeded: 0, bedsAvailable: 0 });
  const peak = {
    week: peakTotal.week,
    daily: peakTotal.daily,
    associatesNeeded: peakTotal.associatesNeeded,
    bedsNeeded: peakTotal.bedsNeeded,
    bedsAvailable: peakTotal.bedsAvailable,
    bedsGap: Math.max(0, peakTotal.bedsNeeded - peakTotal.bedsAvailable),
  };

  const pipeline = await pipelineByChannel(db, p, locationIds, now);
  const mixTotal = RECRUITING_CHANNELS.reduce((a, c) => a + s.channelMix[c], 0) || 100;
  const recruiting: SeasonRecruitingTarget[] = RECRUITING_CHANNELS.map((channel) => {
    const sharePct = s.channelMix[channel];
    const target = Math.round((peak.associatesNeeded * sharePct) / mixTotal);
    return {
      channel,
      label: RECRUITING_CHANNEL_LABELS[channel],
      sharePct,
      target,
      recruitBy: addDays(s.seasonStart, -7 * s.arrivalLeadWeeks[channel]),
      pipeline: pipeline[channel],
      gap: Math.max(0, target - pipeline[channel]),
    };
  });

  const gaps: SeasonGap[] = [];
  for (const site of sites) {
    const pk = site.weeks.find((w) => w.week === site.peak.week);
    const active = actuals.activeNow.get(site.locationId) ?? 0;
    if (site.peak.associatesNeeded > active) {
      gaps.push({
        kind: 'HEADCOUNT',
        siteName: site.siteName,
        week: site.peak.week,
        needed: site.peak.associatesNeeded,
        available: active,
        shortfall: site.peak.associatesNeeded - active,
        text: `${site.siteName} needs ${site.peak.associatesNeeded} associates at its peak (week of ${site.peak.week}); ${active} are active there today — ${site.peak.associatesNeeded - active} short.`,
      });
    }
    if (pk && pk.bedsGap > 0) {
      gaps.push({ kind: 'BEDS', siteName: site.siteName, week: pk.week, needed: pk.bedsNeeded, available: pk.bedsAvailable, shortfall: pk.bedsGap, text: `${site.siteName} needs ${pk.bedsNeeded} beds at peak and has ${pk.bedsAvailable} — ${pk.bedsGap} short.` });
    }
    const worstSeats = site.weeks.reduce((b, w) => (w.vanSeatsGap > b.vanSeatsGap ? w : b), site.weeks[0]);
    if (worstSeats && worstSeats.vanSeatsGap > 0) {
      gaps.push({
        kind: 'VAN_SEATS',
        siteName: site.siteName,
        week: worstSeats.week,
        needed: worstSeats.vanSeatsNeeded,
        available: worstSeats.vanSeatsAvailable,
        shortfall: worstSeats.vanSeatsGap,
        text: `${site.siteName} needs ${worstSeats.vanSeatsNeeded} van seats on its biggest shift (week of ${worstSeats.week}) and the runs carry ${worstSeats.vanSeatsAvailable} — ${worstSeats.vanSeatsGap} short; add a run or a bigger van.`,
      });
    }
  }
  for (const r of recruiting) {
    if (r.gap > 0) {
      gaps.push({ kind: 'RECRUITING', siteName: null, week: r.recruitBy, needed: r.target, available: r.pipeline, shortfall: r.gap, text: `${r.label}: ${r.target} needed by ${r.recruitBy}, ${r.pipeline} on the books — ${r.gap} to recruit.` });
    }
  }
  gaps.sort((a, b) => b.shortfall - a.shortfall);

  return { ...s, sites, totals, peak, recruiting, gaps };
}

/* ---------------------------------------------------------------- CRUD */

export async function listPlans(db: Db = defaultPrisma, opts: { includeArchived?: boolean } = {}): Promise<SeasonPlanSummary[]> {
  const rows = await db.seasonPlan.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    include: PLAN_INCLUDE,
    orderBy: [{ seasonStart: 'desc' }, { updatedAt: 'desc' }],
    take: 200,
  });
  return rows.map(summary);
}

export async function getPlanRow(db: Db, id: string): Promise<PlanRow> {
  const row = await db.seasonPlan.findUnique({ where: { id }, include: PLAN_INCLUDE });
  if (!row) throw new HttpError(404, 'plan_not_found', 'No such season plan.');
  return row;
}

export async function getPlan(db: Db, id: string, now: Date = new Date()): Promise<SeasonPlanComputed> {
  return computePlan(db, await getPlanRow(db, id), now);
}

async function siteInputs(db: Db, input: SeasonPlanInput): Promise<SeasonPlanSiteInput[]> {
  const weeks = seasonWeeks(input.seasonStart, input.seasonEnd);
  if (input.sites && input.sites.length > 0) {
    const ids = input.sites.map((s) => s.locationId);
    const found = await db.site.count({ where: { id: { in: ids }, deletedAt: null } });
    if (found !== ids.length) throw new HttpError(400, 'site_not_found', 'One of those sites does not exist.');
    return input.sites;
  }
  const locations = await db.site.findMany({
    where: { isActive: true, deletedAt: null, ...(input.clientId ? { clientId: input.clientId } : { client: { status: 'ACTIVE', deletedAt: null } }) },
    select: { id: true },
    orderBy: { name: 'asc' },
    take: 60,
  });
  const demand = await defaultDemandFor(db, locations.map((l) => l.id), weeks);
  const vans = await db.van.aggregate({ where: { isActive: true }, _max: { capacity: true } });
  return locations.map((l) => ({
    locationId: l.id,
    bedsAvailable: 0,
    vanSeatsPerRun: vans._max.capacity ?? 14,
    runsPerShift: 1,
    routeMinutes: 45,
    demand: demand.get(l.id) ?? [],
  }));
}

function planData(input: SeasonPlanInput | SeasonPlanUpdate): Prisma.SeasonPlanUpdateInput {
  return {
    name: input.name,
    seasonStart: input.seasonStart ? atUtc(input.seasonStart) : undefined,
    seasonEnd: input.seasonEnd ? atUtc(input.seasonEnd) : undefined,
    targetHoursPerWeek: input.targetHoursPerWeek,
    shiftHours: input.shiftHours,
    reservePct: input.reservePct,
    channelMix: input.channelMix ? (input.channelMix as Prisma.InputJsonObject) : undefined,
    arrivalLeadWeeks: input.arrivalLeadWeeks ? (input.arrivalLeadWeeks as Prisma.InputJsonObject) : undefined,
    housingShare: input.housingShare ? (input.housingShare as Prisma.InputJsonObject) : undefined,
    rideShare: input.rideShare ? (input.rideShare as Prisma.InputJsonObject) : undefined,
    notes: input.notes,
  };
}

export async function createPlan(db: Db, input: SeasonPlanInput, actorUserId: string, now: Date = new Date()): Promise<SeasonPlanComputed> {
  if (input.clientId && !(await db.client.findFirst({ where: { id: input.clientId, deletedAt: null }, select: { id: true } }))) {
    throw new HttpError(400, 'client_not_found', 'No such client.');
  }
  const sites = await siteInputs(db, input);
  const row = await db.seasonPlan.create({
    data: {
      name: input.name,
      clientId: input.clientId ?? null,
      seasonStart: atUtc(input.seasonStart),
      seasonEnd: atUtc(input.seasonEnd),
      targetHoursPerWeek: input.targetHoursPerWeek,
      shiftHours: input.shiftHours,
      reservePct: input.reservePct,
      channelMix: (input.channelMix ?? DEFAULT_MIX) as Prisma.InputJsonObject,
      arrivalLeadWeeks: (input.arrivalLeadWeeks ?? DEFAULT_LEAD) as Prisma.InputJsonObject,
      housingShare: (input.housingShare ?? DEFAULT_HOUSING) as Prisma.InputJsonObject,
      rideShare: (input.rideShare ?? DEFAULT_RIDE) as Prisma.InputJsonObject,
      notes: input.notes ?? null,
      createdById: actorUserId,
      sites: {
        create: sites.map((s) => ({
          locationId: s.locationId,
          bedsAvailable: s.bedsAvailable,
          vanSeatsPerRun: s.vanSeatsPerRun,
          runsPerShift: s.runsPerShift,
          routeMinutes: s.routeMinutes,
          demand: s.demand as unknown as Prisma.InputJsonArray,
        })),
      },
    },
    include: PLAN_INCLUDE,
  });
  return computePlan(db, row, now);
}

export async function updatePlan(db: Db, id: string, input: SeasonPlanUpdate, now: Date = new Date()): Promise<SeasonPlanComputed> {
  const existing = await getPlanRow(db, id);
  const start = input.seasonStart ?? ymd(existing.seasonStart);
  const end = input.seasonEnd ?? ymd(existing.seasonEnd);
  if (end < start) throw new HttpError(400, 'invalid_dates', 'seasonEnd must be on or after seasonStart');
  if (input.sites) {
    const ids = input.sites.map((s) => s.locationId);
    const found = await db.site.count({ where: { id: { in: ids }, deletedAt: null } });
    if (found !== ids.length) throw new HttpError(400, 'site_not_found', 'One of those sites does not exist.');
  }
  const row = await db.seasonPlan.update({
    where: { id },
    data: {
      ...planData(input),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? now : null } : {}),
      ...(input.sites
        ? {
            sites: {
              deleteMany: {},
              create: input.sites.map((s) => ({
                locationId: s.locationId,
                bedsAvailable: s.bedsAvailable,
                vanSeatsPerRun: s.vanSeatsPerRun,
                runsPerShift: s.runsPerShift,
                routeMinutes: s.routeMinutes,
                demand: s.demand as unknown as Prisma.InputJsonArray,
              })),
            },
          }
        : {}),
    },
    include: PLAN_INCLUDE,
  });
  return computePlan(db, row, now);
}

/** A copy to try a different idea on — "Corso overnight-first" next to "original". */
export async function duplicatePlan(db: Db, id: string, name: string, actorUserId: string, now: Date = new Date()): Promise<SeasonPlanComputed> {
  const src = await getPlanRow(db, id);
  const row = await db.seasonPlan.create({
    data: {
      name,
      clientId: src.clientId,
      seasonStart: src.seasonStart,
      seasonEnd: src.seasonEnd,
      targetHoursPerWeek: src.targetHoursPerWeek,
      shiftHours: src.shiftHours,
      reservePct: src.reservePct,
      channelMix: src.channelMix as Prisma.InputJsonObject,
      arrivalLeadWeeks: src.arrivalLeadWeeks as Prisma.InputJsonObject,
      housingShare: src.housingShare as Prisma.InputJsonObject,
      rideShare: src.rideShare as Prisma.InputJsonObject,
      notes: src.notes,
      createdById: actorUserId,
      sites: {
        create: src.sites.map((s) => ({
          locationId: s.locationId,
          bedsAvailable: s.bedsAvailable,
          vanSeatsPerRun: s.vanSeatsPerRun,
          runsPerShift: s.runsPerShift,
          routeMinutes: s.routeMinutes,
          demand: s.demand as Prisma.InputJsonArray,
        })),
      },
    },
    include: PLAN_INCLUDE,
  });
  return computePlan(db, row, now);
}

/** Site × week rows, for the spreadsheet. */
export function planCsv(plan: SeasonPlanComputed): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows: Array<Array<string | number | null>> = [
    ['Plan', 'Site', 'Client', 'Week', 'Day', 'Evening', 'Overnight', 'Daily on floor', 'Shift slots', 'Associates needed', 'Beds needed', 'Beds available', 'Beds gap', 'Van seats needed', 'Van seats available', 'Van seats gap', 'Scheduled hours', 'Active headcount', 'Short days (forecast)'],
  ];
  for (const site of plan.sites) {
    for (const w of site.weeks) {
      rows.push([plan.name, site.siteName, site.clientName, w.week, w.day, w.evening, w.overnight, w.daily, w.shiftSlots, w.associatesNeeded, w.bedsNeeded, w.bedsAvailable, w.bedsGap, w.vanSeatsNeeded, w.vanSeatsAvailable, w.vanSeatsGap, w.scheduledHours, w.activeHeadcount, w.forecastShortDays ?? null]);
    }
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
