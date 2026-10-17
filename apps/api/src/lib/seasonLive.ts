import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { getPlanRow } from './seasonPlanner.js';
import { loadRateCards, resolveRate } from './rateCards.js';
import { dateKeyInZone, orgDateKey, startOfWeekUTC, utcInstantOfLocalMidnight } from './timeAnomalies.js';

/**
 * What-if on the live schedule (field roles, 2026-10): a season plan's
 * demand for one week, laid against the shifts actually on the calendar
 * that week, store by store and shift by shift. The preview changes
 * nothing; "apply" writes the shortfall as DRAFT open shifts the
 * scheduler can publish or delete, tagged so "discard" can take exactly
 * those back and nothing else.
 *
 * Day parts are the planner's: day, evening, overnight — a shift belongs
 * to the part its local start hour falls in (before 12 → day, 12–19 →
 * evening, else overnight), the same fold defaultDemandFor uses.
 */

type Db = PrismaClient;
type Part = 'day' | 'evening' | 'overnight';
const PARTS: Part[] = ['day', 'evening', 'overnight'];
const PART_START: Record<Part, number> = { day: 6, evening: 14, overnight: 22 };
const DAY_MS = 86_400_000;

export interface LiveWhatIfRow {
  locationId: string;
  siteName: string;
  clientId: string;
  clientName: string;
  date: string;
  part: Part;
  planned: number;
  scheduled: number;
  /** Shifts short of the plan (never negative). */
  gap: number;
  /** Shifts over the plan (never negative). */
  over: number;
  /** Draft shifts this plan already wrote for this slot, still unpublished. */
  drafted: number;
}

export interface LiveWhatIf {
  planId: string;
  week: string;
  shiftHours: number;
  rows: LiveWhatIfRow[];
  totals: { planned: number; scheduled: number; gap: number; over: number; drafted: number; gapHours: number; gapCost: number | null; unpriced: number };
}

export function tagFor(planId: string, week: string): string {
  return `season-plan:${planId}:${week}`;
}

function partOf(startsAt: Date, tz: string): Part {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(startsAt));
  return h < 12 ? 'day' : h < 20 ? 'evening' : 'overnight';
}

function weekKey(raw: string | undefined, now: Date): string {
  if (raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new HttpError(400, 'invalid_week', 'week must be YYYY-MM-DD.');
    return orgDateKey(startOfWeekUTC(new Date(`${raw}T12:00:00Z`)));
  }
  return orgDateKey(startOfWeekUTC(now));
}

export async function liveWhatIf(db: Db, planId: string, rawWeek: string | undefined, now: Date = new Date()): Promise<LiveWhatIf> {
  const plan = await getPlanRow(db, planId);
  const week = weekKey(rawWeek, now);
  const sites = plan.sites.filter((s) => s.location.clientId);
  const locationIds = sites.map((s) => s.locationId);
  const siteRows = await db.site.findMany({ where: { id: { in: locationIds } }, select: { id: true, timezone: true } });
  const tzOf = new Map(siteRows.map((s) => [s.id, s.timezone]));
  const from = new Date(`${week}T00:00:00Z`);
  const to = new Date(from.getTime() + 9 * DAY_MS);
  const shifts = locationIds.length
    ? await db.shift.findMany({
        where: { locationId: { in: locationIds }, status: { notIn: ['CANCELLED'] }, startsAt: { gte: new Date(from.getTime() - DAY_MS), lt: to } },
        select: { locationId: true, startsAt: true, status: true, notes: true },
        take: 10_000,
      })
    : [];
  const tag = tagFor(planId, week);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(from.getTime() + i * DAY_MS + 12 * 3_600_000);
    return d.toISOString().slice(0, 10);
  });
  const dayKeys = new Set(days);
  const counted = new Map<string, { scheduled: number; drafted: number }>();
  for (const s of shifts) {
    if (!s.locationId) continue;
    const tz = tzOf.get(s.locationId) ?? 'America/New_York';
    const date = dateKeyInZone(s.startsAt, tz);
    if (!dayKeys.has(date)) continue;
    const key = `${s.locationId}|${date}|${partOf(s.startsAt, tz)}`;
    const c = counted.get(key) ?? { scheduled: 0, drafted: 0 };
    if (s.status === 'DRAFT') {
      if (s.notes?.includes(tag)) c.drafted += 1;
    } else c.scheduled += 1;
    counted.set(key, c);
  }
  const rows: LiveWhatIfRow[] = [];
  for (const site of sites) {
    const demand = (Array.isArray(site.demand) ? (site.demand as Array<{ week: string; day: number; evening: number; overnight: number }>) : []).find((d) => d.week === week);
    for (const date of days) {
      for (const part of PARTS) {
        const planned = Math.max(0, Number(demand?.[part] ?? 0) || 0);
        const c = counted.get(`${site.locationId}|${date}|${part}`) ?? { scheduled: 0, drafted: 0 };
        if (planned === 0 && c.scheduled === 0 && c.drafted === 0) continue;
        rows.push({
          locationId: site.locationId,
          siteName: site.location.name,
          clientId: site.location.clientId!,
          clientName: site.location.client?.name ?? '',
          date,
          part,
          planned,
          scheduled: c.scheduled,
          gap: Math.max(0, planned - c.scheduled - c.drafted),
          over: Math.max(0, c.scheduled - planned),
          drafted: c.drafted,
        });
      }
    }
  }
  // Price the gap the way the schedule prices a shift: the rate card in force, else the standard.
  const cards = await loadRateCards(db, [...new Set(sites.map((s) => s.location.clientId))]);
  let gapCost = 0;
  let unpriced = 0;
  let priced = false;
  for (const r of rows) {
    if (r.gap === 0) continue;
    const rate = resolveRate(cards, { clientId: r.clientId, position: 'Associate', startsAt: new Date(`${r.date}T12:00:00Z`) });
    if (rate.payRate === null) unpriced += r.gap;
    else {
      gapCost += r.gap * plan.shiftHours * rate.payRate;
      priced = true;
    }
  }
  const sum = (k: 'planned' | 'scheduled' | 'gap' | 'over' | 'drafted') => rows.reduce((n, r) => n + r[k], 0);
  return {
    planId,
    week,
    shiftHours: plan.shiftHours,
    rows,
    totals: { planned: sum('planned'), scheduled: sum('scheduled'), gap: sum('gap'), over: sum('over'), drafted: sum('drafted'), gapHours: sum('gap') * plan.shiftHours, gapCost: priced ? Math.round(gapCost * 100) / 100 : null, unpriced },
  };
}

/** Write the shortfall as DRAFT open shifts, tagged to this plan and week. */
export async function applyLiveWhatIf(db: Db, planId: string, rawWeek: string | undefined, actorUserId: string, now: Date = new Date()): Promise<{ week: string; created: number }> {
  const preview = await liveWhatIf(db, planId, rawWeek, now);
  const plan = await getPlanRow(db, planId);
  const siteRows = await db.site.findMany({ where: { id: { in: preview.rows.map((r) => r.locationId) } }, select: { id: true, timezone: true } });
  const tzOf = new Map(siteRows.map((s) => [s.id, s.timezone]));
  const tag = tagFor(planId, preview.week);
  const data: Array<{ clientId: string; locationId: string; position: string; startsAt: Date; endsAt: Date; status: 'DRAFT'; notes: string; createdById: string }> = [];
  for (const r of preview.rows) {
    if (r.gap === 0) continue;
    const tz = tzOf.get(r.locationId) ?? 'America/New_York';
    const midnight = utcInstantOfLocalMidnight(r.date, tz);
    const startsAt = new Date(midnight.getTime() + PART_START[r.part] * 3_600_000);
    const endsAt = new Date(startsAt.getTime() + plan.shiftHours * 3_600_000);
    for (let i = 0; i < r.gap; i += 1) {
      data.push({ clientId: r.clientId, locationId: r.locationId, position: 'Associate', startsAt, endsAt, status: 'DRAFT', notes: `${tag} · ${plan.name}`, createdById: actorUserId });
    }
  }
  if (data.length) await db.shift.createMany({ data });
  return { week: preview.week, created: data.length };
}

/** Take back the drafts this plan wrote for the week — only those, only while still drafts. */
export async function discardLiveWhatIf(db: Db, planId: string, rawWeek: string | undefined, now: Date = new Date()): Promise<{ week: string; removed: number }> {
  const week = weekKey(rawWeek, now);
  const r = await db.shift.deleteMany({ where: { status: 'DRAFT', notes: { startsWith: tagFor(planId, week) } } });
  return { week, removed: r.count };
}
