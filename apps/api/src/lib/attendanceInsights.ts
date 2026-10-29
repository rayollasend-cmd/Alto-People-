import type { Prisma } from '@prisma/client';
import {
  ATTENDANCE_FILL_TARGET_PCT,
  ATTENDANCE_OVERTIME_THRESHOLD_HOURS,
  LATE_GRACE_MINUTES,
  NO_SHOW_RISK_MINUTES,
  can,
  type AttendanceCalendarMetric,
  type AttendanceCalendarResponse,
  type AttendanceHeatmapMetric,
  type AttendanceHeatmapResponse,
  type AttendanceHeatmapRow,
  type AttendanceTrendsResponse,
  type AttendanceWeek,
  type LateNowPerson,
  type LateNowResponse,
  type TeamHoursResponse,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from './tenant.js';
import { effectiveClientIdFilter, scopeAssociatesIncludingFormer, scopeShifts, scopeTimeEntries, scopeWhere } from './scope.js';
import { getLaborPolicy } from './stateLaborPolicy.js';
import { loadLiveRules } from './laborRules/live.js';
import { splitByPerson } from './laborRules/hours.js';
import { teamScope } from './delegations.js';
import { EMPLOYED_WHERE } from './activeDefinition.js';
import { companyWorkweek, dateKeyInZone, endOfWeekUTC, startOfWeekUTC, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { addDaysToKey, dateColumnKey } from './timezone.js';

/**
 * Attendance insights (packages/shared/src/attendanceInsights.ts is the
 * contract): week-by-week fill, no-shows, call-outs, lates and overtime;
 * where in the week (and at which store, or which hour) they cluster; the
 * year of them day by day; who hasn't punched in for a shift that already
 * started; and a line manager's team hours against forty.
 *
 * Every query stands on the caller's tenant and reach: shifts through
 * scopeShifts, time through scopeTimeEntries, people through
 * scopeAssociates — so a store-bound account sees its stores, a shift
 * supervisor their client, a manager their reports. Attendance events
 * carry no shift relation, so they are kept only when their shift resolves
 * through the scoped shift query (or, with no shift, their person through
 * the scoped people query).
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_HEATMAP_DAYS = 184;
const MAX_SITE_ROWS = 20;
/** Rows per page when walking a table in full — nothing is silently capped. */
const PAGE = 10_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

type ShiftWhere = Prisma.ShiftWhereInput;

function shiftScope(user: SessionUser, siteId?: string): ShiftWhere {
  return scopeWhere<ShiftWhere>({ tenantId: tenantIdForWrite() }, scopeShifts(user), siteId ? { locationId: siteId } : null);
}

const PUBLISHED_LIVE: ShiftWhere = { publishedAt: { not: null }, status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] } };

const addDaysKey = addDaysToKey;

/** 0 = the workweek's first day (Saturday by default). */
function dowIndex(key: string, weekStartsOn: number): number {
  const day = new Date(`${key}T12:00:00Z`).getUTCDay();
  return (day - weekStartsOn + 7) % 7;
}

const hourFormats = new Map<string, Intl.DateTimeFormat>();
function hourInZone(at: Date, tz: string): number {
  let f = hourFormats.get(tz);
  if (!f) hourFormats.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })));
  return Number(f.format(at)) % 24;
}

/** A date-only column's YYYY-MM-DD. */
const dateOnlyKey = dateColumnKey;

/* ---- The workweeks ------------------------------------------------------- */

interface Week {
  start: Date;
  end: Date;
  key: string;
}

function lastWeeks(count: number, now: Date): Week[] {
  const tz = companyWorkweek().timezone;
  const current = startOfWeekUTC(now);
  const weeks: Week[] = [];
  for (let i = count - 1; i >= 0; i--) {
    // The middle of the target week, so a DST hour never lands it a week off.
    const start = startOfWeekUTC(new Date(current.getTime() - i * 7 * DAY_MS + 3 * DAY_MS));
    weeks.push({ start, end: endOfWeekUTC(start), key: dateKeyInZone(start, tz) });
  }
  return weeks;
}

function weekIndexOf(weeks: Week[], at: Date): number {
  for (let i = weeks.length - 1; i >= 0; i--) if (at >= weeks[i]!.start && at < weeks[i]!.end) return i;
  return -1;
}

function weekIndexOfKey(weeks: Week[], key: string): number {
  for (let i = weeks.length - 1; i >= 0; i--) if (key >= weeks[i]!.key) return key < addDaysKey(weeks[i]!.key, 7) ? i : -1;
  return -1;
}

/* ---- Shared loaders ------------------------------------------------------ */

interface ShiftRef {
  id: string;
  startsAt: Date;
  locationId: string | null;
  timezone: string;
}

type EventKind = 'LATE' | 'NO_CALL_NO_SHOW' | 'CALL_OUT';

interface ScopedEvent {
  kind: EventKind;
  occurredOn: string;
  excused: boolean;
  shift: ShiftRef | null;
}

/**
 * Attendance events in a date range, kept only inside the caller's reach.
 * With a site named, an event with no shift can't be placed and is left out.
 */
async function scopedEvents(user: SessionUser, kinds: EventKind[], fromKey: string, toKeyExclusive: string, siteId?: string): Promise<ScopedEvent[]> {
  const tenantId = tenantIdForWrite();
  // A client-bound caller's events are narrowed in SQL (an event with no
  // client is still checked below through its shift or person). A bounded
  // role with no client (a site-bound lead) is left to the checks below.
  const bound = effectiveClientIdFilter(user, undefined);
  const where: Prisma.AttendanceEventWhereInput = {
    tenantId,
    kind: { in: kinds },
    occurredOn: { gte: new Date(`${fromKey}T00:00:00Z`), lt: new Date(`${toKeyExclusive}T00:00:00Z`) },
    ...(typeof bound === 'string' ? { OR: [{ clientId: bound }, { clientId: null }] } : {}),
  };
  // Every event in range, page by page — no cap that drops some at random.
  const rows: Array<{ id: string; kind: string; occurredOn: Date; excusedAt: Date | null; shiftId: string | null; associateId: string }> = [];
  for (let cursor: string | undefined; ; ) {
    const page = await prisma.attendanceEvent.findMany({
      where,
      select: { id: true, kind: true, occurredOn: true, excusedAt: true, shiftId: true, associateId: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    rows.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1]!.id;
  }
  const shiftIds = [...new Set(rows.map((r) => r.shiftId).filter((x): x is string => !!x))];
  const shifts: Array<{ id: string; startsAt: Date; locationId: string | null; locationRel: { timezone: string } | null }> = [];
  for (let i = 0; i < shiftIds.length; i += PAGE) {
    shifts.push(
      ...(await prisma.shift.findMany({
        where: scopeWhere<ShiftWhere>(shiftScope(user, siteId), { id: { in: shiftIds.slice(i, i + PAGE) } }),
        select: { id: true, startsAt: true, locationId: true, locationRel: { select: { timezone: true } } },
      })),
    );
  }
  const byId = new Map<string, ShiftRef>(shifts.map((s) => [s.id, { id: s.id, startsAt: s.startsAt, locationId: s.locationId, timezone: s.locationRel?.timezone ?? companyWorkweek().timezone }]));
  const loose = siteId ? [] : [...new Set(rows.filter((r) => !r.shiftId).map((r) => r.associateId))];
  const people = new Set<string>();
  for (let i = 0; i < loose.length; i += PAGE) {
    for (const a of await prisma.associate.findMany({
      where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId }, scopeAssociatesIncludingFormer(user), { id: { in: loose.slice(i, i + PAGE) } }),
      select: { id: true },
    }))
      people.add(a.id);
  }
  const out: ScopedEvent[] = [];
  for (const r of rows) {
    const shift = r.shiftId ? byId.get(r.shiftId) : undefined;
    if (r.shiftId ? !shift : !people.has(r.associateId)) continue;
    out.push({ kind: r.kind as EventKind, occurredOn: dateOnlyKey(r.occurredOn), excused: r.excusedAt !== null, shift: shift ?? null });
  }
  return out;
}

/**
 * Confirmed call-outs on shifts starting in [from, to), inside the caller's
 * reach — the same rows the call-outs desk counts. A PENDING one (a text read
 * as "can't make it", never confirmed) isn't a call-out yet.
 */
async function scopedCallOuts(user: SessionUser, from: Date, to: Date, siteId?: string): Promise<ShiftRef[]> {
  const where: Prisma.CallOutWhereInput = {
    tenantId: tenantIdForWrite(),
    status: 'CONFIRMED',
    shift: scopeWhere<ShiftWhere>(shiftScope(user, siteId), { startsAt: { gte: from, lt: to } }),
  };
  // Page by page: a year of a large company's call-outs runs past any one fetch.
  const out: ShiftRef[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await prisma.callOut.findMany({
      where,
      select: { id: true, shift: { select: { id: true, startsAt: true, locationId: true, locationRel: { select: { timezone: true } } } } },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const r of page) out.push({ id: r.shift.id, startsAt: r.shift.startsAt, locationId: r.shift.locationId, timezone: r.shift.locationRel?.timezone ?? companyWorkweek().timezone });
    if (page.length < PAGE) break;
    cursor = page[page.length - 1]!.id;
  }
  return out;
}

/**
 * Every call-out once: the call-out log, plus the missed shifts a time-off
 * request covered (CALL_OUT events) that the log doesn't already hold.
 */
function mergeCallOuts(logged: ShiftRef[], events: ScopedEvent[]): Array<{ at: Date | null; dayKey: string; shift: ShiftRef | null }> {
  const seen = new Set<string>();
  const out: Array<{ at: Date | null; dayKey: string; shift: ShiftRef | null }> = [];
  for (const s of logged) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ at: s.startsAt, dayKey: dateKeyInZone(s.startsAt, s.timezone), shift: s });
  }
  for (const e of events) {
    if (e.kind !== 'CALL_OUT') continue;
    if (e.shift) {
      if (seen.has(e.shift.id)) continue;
      seen.add(e.shift.id);
      out.push({ at: e.shift.startsAt, dayKey: dateKeyInZone(e.shift.startsAt, e.shift.timezone), shift: e.shift });
    } else {
      out.push({ at: null, dayKey: e.occurredOn, shift: null });
    }
  }
  return out;
}

type CountedMetric = 'late' | 'noshows' | 'callouts';

interface DayPoint {
  /** The day on its store's calendar. */
  dayKey: string;
  at: Date | null;
  shift: ShiftRef | null;
}

/**
 * Each late arrival, no-show or call-out whose day falls in [fromKey,
 * toKey], inside the caller's reach. The day is the shift's start on its
 * store's clock; occurredOn (written as the UTC date of that start) only
 * places an event with no shift. A late or a no-show the policy excused
 * isn't counted, as on the trend lines; an excused call-out still is —
 * nobody came either way, which is what the call-outs desk counts too.
 */
async function dayPoints(user: SessionUser, metric: CountedMetric, fromKey: string, toKey: string, siteId?: string): Promise<DayPoint[]> {
  const orgTz = companyWorkweek().timezone;
  const afterTo = addDaysKey(toKey, 1);
  // A day either side, so every store's own calendar day is covered (and a
  // UTC occurredOn a day off the store's).
  const eventsFrom = addDaysKey(fromKey, -1);
  const eventsTo = addDaysKey(afterTo, 1);
  const out: DayPoint[] = [];
  const keep = (at: Date | null, dayKey: string, shift: ShiftRef | null) => {
    const key = at && shift ? dateKeyInZone(at, shift.timezone) : dayKey;
    if (key >= fromKey && key <= toKey) out.push({ dayKey: key, at, shift });
  };
  if (metric === 'callouts') {
    const [events, logged] = await Promise.all([
      scopedEvents(user, ['CALL_OUT'], eventsFrom, eventsTo, siteId),
      scopedCallOuts(
        user,
        new Date(utcInstantOfLocalMidnight(fromKey, orgTz).getTime() - DAY_MS),
        new Date(utcInstantOfLocalMidnight(afterTo, orgTz).getTime() + DAY_MS),
        siteId,
      ),
    ]);
    for (const c of mergeCallOuts(logged, events)) keep(c.at, c.dayKey, c.shift);
  } else {
    const events = await scopedEvents(user, [metric === 'late' ? 'LATE' : 'NO_CALL_NO_SHOW'], eventsFrom, eventsTo, siteId);
    for (const e of events) if (!e.excused) keep(e.shift?.startsAt ?? null, e.occurredOn, e.shift);
  }
  return out;
}

interface OvertimeSlice {
  at: Date;
  hours: number;
  locationId: string | null;
  timezone: string;
}

/**
 * Overtime as the paycheck counts it: each person's hours split by the
 * labor-rules engine (lib/laborRules/hours) — past 40 in a workweek, or a
 * live jurisdiction's daily and double-time rules — net of every break,
 * the week in the site's zone. The engine fills a week chronologically, so
 * the overtime sits on the punches that ran past the line and can be shown
 * by day and store. An open punch counts to now.
 *
 * Two passes, so a large company's weeks are counted in full: first every
 * punch the people in reach have in range (every client: overtime is the
 * person's whole week), as bare times — gross hours per person and week;
 * then, for only the person-weeks that can hold overtime (gross past 40,
 * or any hour at a live site), the punches with their breaks and stores.
 * A client-bound caller sees the overtime that landed at their client only.
 */
async function overtimeSlices(user: SessionUser, weeks: Week[], now: Date): Promise<Array<OvertimeSlice & { week: number }>> {
  const from = weeks[0]!.start;
  const to = weeks[weeks.length - 1]!.end;
  const tenantId = tenantIdForWrite();
  const base: Prisma.TimeEntryWhereInput = { tenantId, status: { not: 'REJECTED' }, clockInAt: { gte: from, lt: to } };
  const where = scopeWhere<Prisma.TimeEntryWhereInput>(base, scopeTimeEntries(user));
  const rules = await loadLiveRules(prisma, tenantId);

  // The people in reach, then every punch they have in range (bare times).
  const reach = (await prisma.timeEntry.groupBy({ by: ['associateId'], where })).map((g) => g.associateId);
  if (reach.length === 0) return [];
  const gross = new Map<string, number>();
  const liveWeek = new Set<string>();
  for (let i = 0; i < reach.length; i += 1_000) {
    const ids = reach.slice(i, i + 1_000);
    for (let cursor: string | undefined; ; ) {
      const page = await prisma.timeEntry.findMany({
        where: { ...base, associateId: { in: ids } },
        select: { id: true, associateId: true, clockInAt: true, clockOutAt: true, location: { select: { id: true, state: true, city: true } } },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const e of page) {
        const week = weekIndexOf(weeks, e.clockInAt);
        if (week < 0) continue;
        const key = `${e.associateId}|${week}`;
        gross.set(key, (gross.get(key) ?? 0) + Math.max(0, (e.clockOutAt ?? now).getTime() - e.clockInAt.getTime()) / HOUR_MS);
        if (rules.any && rules.activationFor(e.location)) liveWeek.add(key);
      }
      if (page.length < PAGE) break;
      cursor = page[page.length - 1]!.id;
    }
  }
  const over = new Set([...gross].filter(([k, h]) => h > ATTENDANCE_OVERTIME_THRESHOLD_HOURS || liveWeek.has(k)).map(([k]) => k));
  if (over.size === 0) return [];
  const people = [...new Set([...over].map((k) => k.split('|')[0]!))];

  // Pass 2: those people's punches with breaks and stores — all of them for
  // the split, and which of them are in the caller's reach.
  const entries = [];
  const inReach = new Set<string>();
  for (let i = 0; i < people.length; i += 1_000) {
    const ids = people.slice(i, i + 1_000);
    const [all, mine] = await Promise.all([
      prisma.timeEntry.findMany({
        where: { ...base, associateId: { in: ids } },
        select: {
          id: true,
          associateId: true,
          clockInAt: true,
          clockOutAt: true,
          locationId: true,
          location: { select: { id: true, state: true, city: true, timezone: true } },
          shift: { select: { locationId: true, locationRel: { select: { timezone: true } } } },
          breaks: { select: { type: true, startedAt: true, endedAt: true } },
        },
      }),
      prisma.timeEntry.findMany({ where: scopeWhere<Prisma.TimeEntryWhereInput>(where, { associateId: { in: ids } }), select: { id: true } }),
    ]);
    entries.push(...all);
    for (const m of mine) inReach.add(m.id);
  }
  const work = entries.map((e) => ({ ...e, clockOutAt: e.clockOutAt ?? now, site: e.location }));
  const { byEntry } = splitByPerson(rules, work);

  const out: Array<OvertimeSlice & { week: number }> = [];
  for (const e of work) {
    const week = weekIndexOf(weeks, e.clockInAt);
    if (week < 0 || !over.has(`${e.associateId}|${week}`) || !inReach.has(e.id)) continue;
    const share = byEntry.get(e)!;
    const past = share.overtimeHours + share.doubleTimeHours;
    if (past <= 0) continue;
    out.push({
      week,
      at: e.clockInAt,
      hours: past,
      locationId: e.locationId ?? e.shift?.locationId ?? null,
      timezone: e.location?.timezone ?? e.shift?.locationRel?.timezone ?? companyWorkweek().timezone,
    });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/* ---- Trends -------------------------------------------------------------- */

export async function attendanceTrends(user: SessionUser, q: { weeks: number; siteId?: string }, now = new Date()): Promise<AttendanceTrendsResponse> {
  const weeks = lastWeeks(q.weeks, now);
  const from = weeks[0]!.start;
  const to = weeks[weeks.length - 1]!.end;
  const scope = shiftScope(user, q.siteId);

  const [fill, events, logged, overtime] = await Promise.all([
    Promise.all(
      weeks.map((w) =>
        prisma.shift.groupBy({
          by: ['status'],
          // The week in progress counts the shifts that have started: a
          // future open shift isn't a miss yet.
          where: scopeWhere<ShiftWhere>(scope, PUBLISHED_LIVE, { startsAt: { gte: w.start, lt: w.end < now ? w.end : now } }),
          _count: true,
        }),
      ),
    ),
    scopedEvents(user, ['LATE', 'NO_CALL_NO_SHOW', 'CALL_OUT'], weeks[0]!.key, addDaysKey(weeks[weeks.length - 1]!.key, 7), q.siteId),
    scopedCallOuts(user, from, to, q.siteId),
    overtimeSlices(user, weeks, now),
  ]);

  const out: AttendanceWeek[] = weeks.map((w, i) => {
    const groups = fill[i]!;
    const open = groups.find((g) => g.status === 'OPEN')?._count ?? 0;
    const filled = groups.filter((g) => g.status !== 'OPEN').reduce((n, g) => n + g._count, 0);
    const scheduled = open + filled;
    return {
      weekStart: w.key,
      inProgress: now >= w.start && now < w.end,
      scheduledShifts: scheduled,
      filledShifts: filled,
      fillRatePct: scheduled > 0 ? Math.round((filled / scheduled) * 100) : null,
      noCallNoShows: 0,
      callOuts: 0,
      lates: 0,
      overtimeHours: 0,
    };
  });
  for (const e of events) {
    if (e.excused || e.kind === 'CALL_OUT') continue;
    // By the shift's real start (occurredOn is the UTC date — a Friday
    // evening shift's would land on Saturday, in the next workweek).
    const i = e.shift ? weekIndexOf(weeks, e.shift.startsAt) : weekIndexOfKey(weeks, e.occurredOn);
    if (i < 0) continue;
    if (e.kind === 'LATE') out[i]!.lates += 1;
    else out[i]!.noCallNoShows += 1;
  }
  for (const c of mergeCallOuts(logged, events)) {
    const i = c.at ? weekIndexOf(weeks, c.at) : weekIndexOfKey(weeks, c.dayKey);
    if (i >= 0) out[i]!.callOuts += 1;
  }
  for (const s of overtime) {
    if (q.siteId && s.locationId !== q.siteId) continue;
    out[s.week]!.overtimeHours += s.hours;
  }
  for (const w of out) w.overtimeHours = round1(w.overtimeHours);

  return { generatedAt: now.toISOString(), siteId: q.siteId ?? null, fillTargetPct: ATTENDANCE_FILL_TARGET_PCT, weeks: out };
}

/* ---- Heatmap ------------------------------------------------------------- */

export async function attendanceHeatmap(
  user: SessionUser,
  q: { metric: AttendanceHeatmapMetric; from?: string; to?: string; siteId?: string },
  now = new Date(),
): Promise<AttendanceHeatmapResponse> {
  const { timezone: orgTz, weekStartsOn } = companyWorkweek();
  const toKey = q.to ?? dateKeyInZone(now, orgTz);
  const fromKey = q.from ?? addDaysKey(toKey, -55);
  if (fromKey > toKey) throw new HttpError(400, 'invalid_range', 'The start date is after the end date.');
  const span = (Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY_MS + 1;
  if (span > MAX_HEATMAP_DAYS) throw new HttpError(400, 'range_too_long', `Pick a range of ${MAX_HEATMAP_DAYS} days or fewer.`);
  const by: 'site' | 'hour' = q.siteId ? 'hour' : 'site';

  // Each point: its store, its day on that store's calendar, its hour.
  const points: Array<{ siteId: string | null; dayKey: string; hour: number | null; value: number }> = [];
  if (q.metric === 'overtime') {
    // A day either side, so every store's own calendar day is covered.
    const from = new Date(utcInstantOfLocalMidnight(fromKey, orgTz).getTime() - DAY_MS);
    const to = new Date(utcInstantOfLocalMidnight(addDaysKey(toKey, 1), orgTz).getTime() + DAY_MS);
    // Overtime is weekly: walk whole workweeks so the line at 40 is right.
    const weeks: Week[] = [];
    for (let w = startOfWeekUTC(from); w < to; w = endOfWeekUTC(w)) weeks.push({ start: w, end: endOfWeekUTC(w), key: dateKeyInZone(w, orgTz) });
    for (const s of await overtimeSlices(user, weeks, now)) {
      if (q.siteId && s.locationId !== q.siteId) continue;
      const key = dateKeyInZone(s.at, s.timezone);
      if (key < fromKey || key > toKey) continue;
      points.push({ siteId: s.locationId, dayKey: key, hour: hourInZone(s.at, s.timezone), value: s.hours });
    }
  } else {
    for (const p of await dayPoints(user, q.metric, fromKey, toKey, q.siteId)) {
      points.push({ siteId: p.shift?.locationId ?? null, dayKey: p.dayKey, hour: p.at && p.shift ? hourInZone(p.at, p.shift.timezone) : null, value: 1 });
    }
  }

  const days = Array.from({ length: 7 }, (_, i) => DOW[(weekStartsOn + i) % 7]!);
  const grid = new Map<string, number[]>();
  const cell = (key: string) => {
    let row = grid.get(key);
    if (!row) grid.set(key, (row = [0, 0, 0, 0, 0, 0, 0]));
    return row;
  };
  for (const p of points) {
    const key = by === 'hour' ? (p.hour === null ? null : String(p.hour).padStart(2, '0')) : (p.siteId ?? 'none');
    if (key === null) continue;
    cell(key)[dowIndex(p.dayKey, weekStartsOn)]! += p.value;
  }

  let rows: AttendanceHeatmapRow[];
  if (by === 'hour') {
    const hours = [...grid.keys()].map(Number).sort((a, b) => a - b);
    rows = hours.length === 0 ? [] : Array.from({ length: hours[hours.length - 1]! - hours[0]! + 1 }, (_, i) => {
      const h = hours[0]! + i;
      const key = String(h).padStart(2, '0');
      const values = grid.get(key) ?? [0, 0, 0, 0, 0, 0, 0];
      return { key, label: hourLabel(h), values, total: 0 };
    });
  } else {
    const ids = [...grid.keys()].filter((k) => k !== 'none');
    const sites = ids.length
      ? await prisma.site.findMany({ where: { tenantId: tenantIdForWrite(), id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const names = new Map(sites.map((s) => [s.id, s.name]));
    rows = [...grid.entries()].map(([key, values]) => ({ key, label: key === 'none' ? 'No location' : (names.get(key) ?? 'Location'), values, total: 0 }));
  }
  for (const r of rows) {
    r.values = r.values.map((v) => (q.metric === 'overtime' ? round1(v) : v));
    r.total = round1(r.values.reduce((a, b) => a + b, 0));
  }
  if (by === 'site') {
    rows.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    if (rows.length > MAX_SITE_ROWS) {
      const rest = rows.slice(MAX_SITE_ROWS - 1);
      const values = days.map((_, i) => round1(rest.reduce((n, r) => n + r.values[i]!, 0)));
      rows = [...rows.slice(0, MAX_SITE_ROWS - 1), { key: 'other', label: `${rest.length} other locations`, values, total: round1(values.reduce((a, b) => a + b, 0)) }];
    }
  }
  const max = rows.reduce((m, r) => Math.max(m, ...r.values), 0);
  const total = round1(rows.reduce((n, r) => n + r.total, 0));
  return { metric: q.metric, from: fromKey, to: toKey, siteId: q.siteId ?? null, by, unit: q.metric === 'overtime' ? 'hours' : 'count', days, rows, max, total };
}

function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/* ---- The year, day by day ------------------------------------------------ */

/**
 * One count per day for the last `days` days, today (the company's) last:
 * call-outs, no-shows or late arrivals, each on its store's own day, in the
 * caller's reach — the same points the heatmap folds by day of the week.
 */
export async function attendanceCalendar(
  user: SessionUser,
  q: { metric: AttendanceCalendarMetric; days: number; siteId?: string },
  now = new Date(),
): Promise<AttendanceCalendarResponse> {
  const { timezone: orgTz, weekStartsOn } = companyWorkweek();
  const toKey = dateKeyInZone(now, orgTz);
  const fromKey = addDaysKey(toKey, -(q.days - 1));
  const counts = new Map<string, number>();
  for (const p of await dayPoints(user, q.metric, fromKey, toKey, q.siteId)) counts.set(p.dayKey, (counts.get(p.dayKey) ?? 0) + 1);

  const days = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, value]) => ({ date, value }));
  const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  let busiest: AttendanceCalendarResponse['busiest'] = null;
  for (const d of days) {
    total += d.value;
    weekdayTotals[new Date(`${d.date}T12:00:00Z`).getUTCDay()]! += d.value;
    if (!busiest || d.value >= busiest.value) busiest = d;
  }
  return { metric: q.metric, from: fromKey, to: toKey, siteId: q.siteId ?? null, firstDay: weekStartsOn, days, total, busiest, weekdayTotals };
}

/* ---- Not in yet ---------------------------------------------------------- */

/** Who may see a phone number and call or text from this list. */
function mayReachCrew(user: SessionUser): boolean {
  if (user.role === 'CLIENT_PORTAL' || user.role === 'FLOOR_SUPERVISOR' || user.role === 'ASSOCIATE') return false;
  return can(user, 'manage:time') || can(user, 'message:crew');
}

/**
 * Whether /floor/crew-text can reach this shift for the caller: it texts one
 * client's shifts at a time, clamped to a client-bound caller's own — so a
 * shift with no client, or a bounded caller with none, can't be texted here.
 */
function textableFor(user: SessionUser, shiftClientId: string | null): boolean {
  if (!shiftClientId) return false;
  const bound = effectiveClientIdFilter(user, undefined);
  if (bound === undefined) return true;
  return bound === shiftClientId;
}

export async function lateNow(user: SessionUser, q: { siteId?: string }, now = new Date()): Promise<LateNowResponse> {
  const shifts = await prisma.shift.findMany({
    where: scopeWhere<ShiftWhere>(shiftScope(user, q.siteId), {
      status: 'ASSIGNED',
      publishedAt: { not: null },
      assignedAssociateId: { not: null },
      startsAt: { lte: now, gte: new Date(now.getTime() - 16 * HOUR_MS) },
      endsAt: { gt: now },
    }),
    select: {
      id: true,
      position: true,
      startsAt: true,
      endsAt: true,
      clientId: true,
      locationId: true,
      locationRel: { select: { name: true, timezone: true } },
      assignedAssociateId: true,
      assignedAssociate: { select: { firstName: true, lastName: true, phone: true } },
    },
    orderBy: { startsAt: 'asc' },
    take: 1_000,
  });
  const reach = mayReachCrew(user);
  // A client-bound role with no client has nothing crew-text can reach.
  const mayText = reach && can(user, 'message:crew') && effectiveClientIdFilter(user, undefined) !== null;
  const base: LateNowResponse = { generatedAt: now.toISOString(), graceMinutes: LATE_GRACE_MINUTES, noShowRiskMinutes: NO_SHOW_RISK_MINUTES, canText: mayText, people: [] };
  if (shifts.length === 0) return base;

  const tz = (s: (typeof shifts)[number]) => s.locationRel?.timezone ?? companyWorkweek().timezone;
  const dayOf = (s: (typeof shifts)[number]) => dateKeyInZone(s.startsAt, tz(s));
  const associateIds = [...new Set(shifts.map((s) => s.assignedAssociateId!))];
  const shiftIds = shifts.map((s) => s.id);
  const days = shifts.map(dayOf).sort();
  const earliest = shifts.reduce((m, s) => (s.startsAt < m ? s.startsAt : m), shifts[0]!.startsAt);
  const [entries, callOuts, declined, leave] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { tenantId: tenantIdForWrite(), associateId: { in: associateIds }, clockInAt: { gte: new Date(earliest.getTime() - 3 * HOUR_MS) } },
      select: { associateId: true, shiftId: true, clockInAt: true, clockOutAt: true },
      take: 5_000,
    }),
    prisma.callOut.findMany({ where: { tenantId: tenantIdForWrite(), shiftId: { in: shiftIds }, status: { not: 'CANCELLED' } }, select: { shiftId: true, status: true } }),
    prisma.attendanceConfirmation.findMany({ where: { shiftId: { in: shiftIds }, answer: 'NO' }, select: { shiftId: true } }),
    // Approved time off doesn't release a shift on its own (the agent only
    // proposes cover) — such a shift is still "theirs" yet nobody's coming.
    prisma.timeOffRequest.findMany({
      where: {
        tenantId: tenantIdForWrite(),
        associateId: { in: associateIds },
        status: 'APPROVED',
        startDate: { lte: new Date(`${days[days.length - 1]}T00:00:00Z`) },
        endDate: { gte: new Date(`${days[0]}T00:00:00Z`) },
      },
      select: { associateId: true, startDate: true, endDate: true },
    }),
  ]);
  const howCalledOut = new Map<string, NonNullable<LateNowPerson['calledOutHow']>>();
  for (const d of declined) howCalledOut.set(d.shiftId, 'reminder-no');
  for (const c of callOuts) howCalledOut.set(c.shiftId, c.status === 'CONFIRMED' ? 'confirmed' : 'unconfirmed');
  const onLeave = (s: (typeof shifts)[number]) => {
    const day = dayOf(s);
    return leave.some((l) => l.associateId === s.assignedAssociateId && dateOnlyKey(l.startDate) <= day && dateOnlyKey(l.endDate) >= day);
  };
  const punched = (s: (typeof shifts)[number]) =>
    entries.some(
      (e) =>
        e.shiftId === s.id ||
        (e.associateId === s.assignedAssociateId &&
          e.clockInAt.getTime() >= s.startsAt.getTime() - 3 * HOUR_MS &&
          e.clockInAt < s.endsAt &&
          (e.clockOutAt === null || e.clockOutAt > s.startsAt)),
    );

  const people: LateNowPerson[] = [];
  for (const s of shifts) {
    if (punched(s)) continue;
    const a = s.assignedAssociate!;
    const minutesLate = Math.max(0, Math.floor((now.getTime() - s.startsAt.getTime()) / 60_000));
    const how = howCalledOut.get(s.id) ?? null;
    const status: LateNowPerson['status'] = how
      ? 'called-out'
      : onLeave(s)
        ? 'on-leave'
        : minutesLate >= NO_SHOW_RISK_MINUTES
          ? 'no-show-risk'
          : minutesLate > LATE_GRACE_MINUTES
            ? 'late'
            : 'due';
    people.push({
      shiftId: s.id,
      associateId: s.assignedAssociateId!,
      name: `${a.firstName} ${a.lastName}`.trim(),
      position: s.position,
      clientId: s.clientId,
      siteId: s.locationId,
      siteName: s.locationRel?.name ?? null,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      timezone: tz(s),
      minutesLate,
      status,
      calledOutHow: how,
      hasPhone: !!a.phone,
      textable: mayText && !!a.phone && textableFor(user, s.clientId),
      phone: reach ? (a.phone ?? null) : null,
    });
  }
  people.sort((x, y) => y.minutesLate - x.minutesLate || x.name.localeCompare(y.name));
  return { ...base, canText: mayText && people.some((p) => p.textable), people };
}

/* ---- Team hours ---------------------------------------------------------- */

export async function teamHours(user: SessionUser, now = new Date()): Promise<TeamHoursResponse> {
  const tz = companyWorkweek().timezone;
  const start = startOfWeekUTC(now);
  const end = endOfWeekUTC(now);
  const base: TeamHoursResponse = { weekStart: dateKeyInZone(start, tz), weekEnd: dateKeyInZone(end, tz), thresholdHours: ATTENDANCE_OVERTIME_THRESHOLD_HOURS, people: [] };
  const reports = await prisma.associate.findMany({
    where: { AND: [{ tenantId: tenantIdForWrite() }, await teamScope(user), EMPLOYED_WHERE] },
    select: { id: true, firstName: true, lastName: true },
    take: 500,
  });
  if (reports.length === 0) return base;
  const ids = reports.map((r) => r.id);
  const [entries, shifts] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { tenantId: tenantIdForWrite(), associateId: { in: ids }, status: { not: 'REJECTED' }, clockInAt: { gte: start, lt: end } },
      select: { associateId: true, clockInAt: true, clockOutAt: true, breaks: { select: { type: true, startedAt: true, endedAt: true } } },
      take: 10_000,
    }),
    // Shifts still ahead — and the one under way, whose rest still counts.
    prisma.shift.findMany({
      where: { tenantId: tenantIdForWrite(), assignedAssociateId: { in: ids }, status: 'ASSIGNED', publishedAt: { not: null }, endsAt: { gt: now }, startsAt: { lt: end } },
      select: { assignedAssociateId: true, startsAt: true, endsAt: true, locationRel: { select: { state: true } } },
      take: 10_000,
    }),
  ]);
  const worked = new Map<string, number>();
  const onClock = new Set<string>();
  /** People on the clock now who have already taken a meal on this punch. */
  const atePunch = new Set<string>();
  for (const e of entries) {
    const stop = (e.clockOutAt ?? now).getTime();
    let ms = Math.max(0, stop - e.clockInAt.getTime());
    for (const b of e.breaks) if (b.type === 'MEAL') ms -= Math.max(0, (b.endedAt ?? new Date(stop)).getTime() - b.startedAt.getTime());
    worked.set(e.associateId, (worked.get(e.associateId) ?? 0) + Math.max(0, ms / HOUR_MS));
    if (!e.clockOutAt) {
      onClock.add(e.associateId);
      if (e.breaks.some((b) => b.type === 'MEAL')) atePunch.add(e.associateId);
    }
  }
  const ahead = new Map<string, number>();
  for (const s of shifts) {
    const id = s.assignedAssociateId!;
    const spanH = (s.endsAt.getTime() - s.startsAt.getTime()) / HOUR_MS;
    const from = Math.max(s.startsAt.getTime(), now.getTime());
    let hours = Math.max(0, (Math.min(s.endsAt.getTime(), end.getTime()) - from) / HOUR_MS);
    // Worked hours are net of the unpaid meal; so is this. The state's rule
    // where it has one, else the usual half hour on a shift of six or more.
    const policy = getLaborPolicy(s.locationRel?.state);
    const mealAfter = policy.mealBreakRequiredAfterHours ?? 6;
    const mealH = (policy.mealBreakRequiredAfterHours !== null ? policy.mealBreakMinMinutes : 30) / 60;
    const underWay = s.startsAt <= now;
    if (spanH >= mealAfter && !(underWay && atePunch.has(id))) hours = Math.max(0, hours - mealH);
    ahead.set(id, (ahead.get(id) ?? 0) + hours);
  }
  const people = reports.map((r) => {
    const w = round1(worked.get(r.id) ?? 0);
    const sch = round1(ahead.get(r.id) ?? 0);
    return { associateId: r.id, name: `${r.firstName} ${r.lastName}`.trim(), workedHours: w, scheduledHours: sch, projectedHours: round1(w + sch), onClock: onClock.has(r.id) };
  });
  people.sort((a, b) => b.projectedHours - a.projectedHours || a.name.localeCompare(b.name));
  return { ...base, people };
}
