import type { Prisma } from '@prisma/client';
import {
  ATTENDANCE_FILL_TARGET_PCT,
  ATTENDANCE_OVERTIME_THRESHOLD_HOURS,
  LATE_GRACE_MINUTES,
  NO_SHOW_RISK_MINUTES,
  can,
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
import { scopeAssociatesIncludingFormer, scopeShifts, scopeTimeEntries, scopeWhere } from './scope.js';
import { teamScope } from './delegations.js';
import { EMPLOYED_WHERE } from './activeDefinition.js';
import { companyWorkweek, dateKeyInZone, endOfWeekUTC, startOfWeekUTC, utcInstantOfLocalMidnight } from './timeAnomalies.js';

/**
 * Attendance insights (packages/shared/src/attendanceInsights.ts is the
 * contract): week-by-week fill, no-shows, call-outs, lates and overtime;
 * where in the week (and at which store, or which hour) they cluster; who
 * hasn't punched in for a shift that already started; and a line manager's
 * team hours against forty.
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
const round1 = (n: number) => Math.round(n * 10) / 10;

type ShiftWhere = Prisma.ShiftWhereInput;

function shiftScope(user: SessionUser, siteId?: string): ShiftWhere {
  return scopeWhere<ShiftWhere>({ tenantId: tenantIdForWrite() }, scopeShifts(user), siteId ? { locationId: siteId } : null);
}

const PUBLISHED_LIVE: ShiftWhere = { publishedAt: { not: null }, status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] } };

function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

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
const dateOnlyKey = (d: Date) => d.toISOString().slice(0, 10);

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
  const rows = await prisma.attendanceEvent.findMany({
    where: { tenantId, kind: { in: kinds }, occurredOn: { gte: new Date(`${fromKey}T00:00:00Z`), lt: new Date(`${toKeyExclusive}T00:00:00Z`) } },
    select: { kind: true, occurredOn: true, excusedAt: true, shiftId: true, associateId: true },
    take: 20_000,
  });
  const shiftIds = [...new Set(rows.map((r) => r.shiftId).filter((x): x is string => !!x))];
  const shifts = shiftIds.length
    ? await prisma.shift.findMany({
        where: scopeWhere<ShiftWhere>(shiftScope(user, siteId), { id: { in: shiftIds } }),
        select: { id: true, startsAt: true, locationId: true, locationRel: { select: { timezone: true } } },
      })
    : [];
  const byId = new Map<string, ShiftRef>(shifts.map((s) => [s.id, { id: s.id, startsAt: s.startsAt, locationId: s.locationId, timezone: s.locationRel?.timezone ?? companyWorkweek().timezone }]));
  const loose = siteId ? [] : [...new Set(rows.filter((r) => !r.shiftId).map((r) => r.associateId))];
  const people = loose.length
    ? new Set(
        (
          await prisma.associate.findMany({
            where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId }, scopeAssociatesIncludingFormer(user), { id: { in: loose } }),
            select: { id: true },
          })
        ).map((a) => a.id),
      )
    : new Set<string>();
  const out: ScopedEvent[] = [];
  for (const r of rows) {
    const shift = r.shiftId ? byId.get(r.shiftId) : undefined;
    if (r.shiftId ? !shift : !people.has(r.associateId)) continue;
    out.push({ kind: r.kind as EventKind, occurredOn: dateOnlyKey(r.occurredOn), excused: r.excusedAt !== null, shift: shift ?? null });
  }
  return out;
}

/** Logged call-outs on shifts starting in [from, to), inside the caller's reach. */
async function scopedCallOuts(user: SessionUser, from: Date, to: Date, siteId?: string): Promise<ShiftRef[]> {
  const rows = await prisma.callOut.findMany({
    where: {
      tenantId: tenantIdForWrite(),
      status: { not: 'CANCELLED' },
      shift: scopeWhere<ShiftWhere>(shiftScope(user, siteId), { startsAt: { gte: from, lt: to } }),
    },
    select: { shift: { select: { id: true, startsAt: true, locationId: true, locationRel: { select: { timezone: true } } } } },
    take: 20_000,
  });
  return rows.map((r) => ({ id: r.shift.id, startsAt: r.shift.startsAt, locationId: r.shift.locationId, timezone: r.shift.locationRel?.timezone ?? companyWorkweek().timezone }));
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

interface OvertimeSlice {
  at: Date;
  hours: number;
  locationId: string | null;
  timezone: string;
}

/**
 * Overtime as the FLSA counts it: each person's hours past 40 in a
 * workweek, net of unpaid meal breaks. The hours past the line are placed
 * on the punches that crossed it, so they can be shown by day and store.
 * An open punch counts to now.
 */
async function overtimeSlices(user: SessionUser, weeks: Week[], now: Date): Promise<Array<OvertimeSlice & { week: number }>> {
  const from = weeks[0]!.start;
  const to = weeks[weeks.length - 1]!.end;
  const entries = await prisma.timeEntry.findMany({
    where: scopeWhere<Prisma.TimeEntryWhereInput>({ tenantId: tenantIdForWrite(), status: { not: 'REJECTED' }, clockInAt: { gte: from, lt: to } }, scopeTimeEntries(user)),
    select: {
      associateId: true,
      clockInAt: true,
      clockOutAt: true,
      locationId: true,
      location: { select: { timezone: true } },
      shift: { select: { locationId: true, locationRel: { select: { timezone: true } } } },
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
    },
    orderBy: { clockInAt: 'asc' },
    take: 50_000,
  });
  const totals = new Map<string, number>();
  const out: Array<OvertimeSlice & { week: number }> = [];
  for (const e of entries) {
    const week = weekIndexOf(weeks, e.clockInAt);
    if (week < 0) continue;
    const end = (e.clockOutAt ?? now).getTime();
    let ms = Math.max(0, end - e.clockInAt.getTime());
    for (const b of e.breaks) {
      if (b.type !== 'MEAL') continue;
      ms -= Math.max(0, (b.endedAt ?? new Date(end)).getTime() - b.startedAt.getTime());
    }
    const hours = Math.max(0, ms / HOUR_MS);
    const key = `${e.associateId}|${week}`;
    const before = totals.get(key) ?? 0;
    const after = before + hours;
    totals.set(key, after);
    const over = after - Math.max(before, ATTENDANCE_OVERTIME_THRESHOLD_HOURS);
    if (over <= 0) continue;
    out.push({
      week,
      at: e.clockInAt,
      hours: over,
      locationId: e.locationId ?? e.shift?.locationId ?? null,
      timezone: e.location?.timezone ?? e.shift?.locationRel?.timezone ?? companyWorkweek().timezone,
    });
  }
  return out;
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
          where: scopeWhere<ShiftWhere>(scope, PUBLISHED_LIVE, { startsAt: { gte: w.start, lt: w.end } }),
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
    const i = weekIndexOfKey(weeks, e.occurredOn);
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
  const afterTo = addDaysKey(toKey, 1);
  // A day either side, so every store's own calendar day is covered.
  const from = new Date(utcInstantOfLocalMidnight(fromKey, orgTz).getTime() - DAY_MS);
  const to = new Date(utcInstantOfLocalMidnight(afterTo, orgTz).getTime() + DAY_MS);
  const by: 'site' | 'hour' = q.siteId ? 'hour' : 'site';

  // Each point: its store, its day on that store's calendar, its hour.
  const points: Array<{ siteId: string | null; dayKey: string; hour: number | null; value: number }> = [];
  const place = (at: Date | null, dayKey: string, shift: { locationId: string | null; timezone: string } | null, value: number) => {
    const key = at && shift ? dateKeyInZone(at, shift.timezone) : dayKey;
    if (key < fromKey || key > toKey) return;
    points.push({ siteId: shift?.locationId ?? null, dayKey: key, hour: at && shift ? hourInZone(at, shift.timezone) : null, value });
  };

  if (q.metric === 'late') {
    const events = await scopedEvents(user, ['LATE'], addDaysKey(fromKey, -1), addDaysKey(afterTo, 1), q.siteId);
    for (const e of events) if (!e.excused) place(e.shift?.startsAt ?? null, e.occurredOn, e.shift, 1);
  } else if (q.metric === 'callouts') {
    const [events, logged] = await Promise.all([
      scopedEvents(user, ['CALL_OUT'], addDaysKey(fromKey, -1), addDaysKey(afterTo, 1), q.siteId),
      scopedCallOuts(user, from, to, q.siteId),
    ]);
    for (const c of mergeCallOuts(logged, events)) place(c.at, c.dayKey, c.shift, 1);
  } else {
    // Overtime is weekly: walk whole workweeks so the line at 40 is right.
    const weeks: Week[] = [];
    for (let w = startOfWeekUTC(from); w < to; w = endOfWeekUTC(w)) weeks.push({ start: w, end: endOfWeekUTC(w), key: dateKeyInZone(w, orgTz) });
    for (const s of await overtimeSlices(user, weeks, now)) {
      if (q.siteId && s.locationId !== q.siteId) continue;
      place(s.at, '', s, s.hours);
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

/* ---- Not in yet ---------------------------------------------------------- */

/** Who may see a phone number and call or text from this list. */
function mayReachCrew(user: SessionUser): boolean {
  if (user.role === 'CLIENT_PORTAL' || user.role === 'FLOOR_SUPERVISOR' || user.role === 'ASSOCIATE') return false;
  return can(user, 'manage:time') || can(user, 'message:crew');
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
    take: 500,
  });
  const reach = mayReachCrew(user);
  const base: LateNowResponse = { generatedAt: now.toISOString(), graceMinutes: LATE_GRACE_MINUTES, noShowRiskMinutes: NO_SHOW_RISK_MINUTES, canText: reach && can(user, 'message:crew'), people: [] };
  if (shifts.length === 0) return base;

  const associateIds = [...new Set(shifts.map((s) => s.assignedAssociateId!))];
  const shiftIds = shifts.map((s) => s.id);
  const earliest = shifts.reduce((m, s) => (s.startsAt < m ? s.startsAt : m), shifts[0]!.startsAt);
  const [entries, callOuts, declined] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { tenantId: tenantIdForWrite(), associateId: { in: associateIds }, clockInAt: { gte: new Date(earliest.getTime() - 3 * HOUR_MS) } },
      select: { associateId: true, shiftId: true, clockInAt: true, clockOutAt: true },
      take: 5_000,
    }),
    prisma.callOut.findMany({ where: { tenantId: tenantIdForWrite(), shiftId: { in: shiftIds }, status: { not: 'CANCELLED' } }, select: { shiftId: true } }),
    prisma.attendanceConfirmation.findMany({ where: { shiftId: { in: shiftIds }, answer: 'NO' }, select: { shiftId: true } }),
  ]);
  const calledOut = new Set([...callOuts.map((c) => c.shiftId), ...declined.map((d) => d.shiftId)]);
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
    const status: LateNowPerson['status'] = calledOut.has(s.id)
      ? 'called-out'
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
      timezone: s.locationRel?.timezone ?? companyWorkweek().timezone,
      minutesLate,
      status,
      hasPhone: !!a.phone,
      phone: reach ? (a.phone ?? null) : null,
    });
  }
  people.sort((x, y) => y.minutesLate - x.minutesLate || x.name.localeCompare(y.name));
  return { ...base, people };
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
    prisma.shift.findMany({
      where: { tenantId: tenantIdForWrite(), assignedAssociateId: { in: ids }, status: 'ASSIGNED', publishedAt: { not: null }, startsAt: { gte: now, lt: end } },
      select: { assignedAssociateId: true, startsAt: true, endsAt: true },
      take: 10_000,
    }),
  ]);
  const worked = new Map<string, number>();
  const onClock = new Set<string>();
  for (const e of entries) {
    const stop = (e.clockOutAt ?? now).getTime();
    let ms = Math.max(0, stop - e.clockInAt.getTime());
    for (const b of e.breaks) if (b.type === 'MEAL') ms -= Math.max(0, (b.endedAt ?? new Date(stop)).getTime() - b.startedAt.getTime());
    worked.set(e.associateId, (worked.get(e.associateId) ?? 0) + Math.max(0, ms / HOUR_MS));
    if (!e.clockOutAt) onClock.add(e.associateId);
  }
  const ahead = new Map<string, number>();
  for (const s of shifts) {
    const id = s.assignedAssociateId!;
    ahead.set(id, (ahead.get(id) ?? 0) + Math.max(0, (Math.min(s.endsAt.getTime(), end.getTime()) - s.startsAt.getTime()) / HOUR_MS));
  }
  const people = reports.map((r) => {
    const w = round1(worked.get(r.id) ?? 0);
    const sch = round1(ahead.get(r.id) ?? 0);
    return { associateId: r.id, name: `${r.firstName} ${r.lastName}`.trim(), workedHours: w, scheduledHours: sch, projectedHours: round1(w + sch), onClock: onClock.has(r.id) };
  });
  people.sort((a, b) => b.projectedHours - a.projectedHours || a.name.localeCompare(b.name));
  return { ...base, people };
}
