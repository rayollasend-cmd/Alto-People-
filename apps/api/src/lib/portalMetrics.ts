import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { zonedMinutes } from './timezone.js';
import {
  dateKeyInZone,
  endOfWeekInZone,
  startOfWeekInZone,
  utcInstantOfLocalMidnight,
} from './timeAnomalies.js';

/**
 * The portal's measuring instruments — shared by the store site
 * (routes/clientPortal.ts) and the region command center (routes/region.ts)
 * so no two surfaces ever read a shift, a punch, or a target differently.
 *
 * Scope → shift / punch filters, floor targets by the hour, hourly
 * delivered-vs-contracted coverage, punch evidence, attendance filters,
 * the reviewed marks, and the grade.
 */

export const ORG_TZ = 'America/New_York';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function fullName(a: { firstName: string; lastName: string }): string {
  return `${a.firstName} ${a.lastName}`.trim();
}

/** Calendar-day arithmetic through the key (not +24h) so DST days keep
 *  their local-midnight boundaries. */
export function nextKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/**
 * The store's calendar: days cut at the store's midnight, Saturday-start
 * weeks on the store's clock. A 10 PM Pacific overnight crew belongs to the
 * Pacific day it starts on — on the org's (Eastern) calendar it would be
 * tomorrow, and the store manager would see it in the wrong column.
 */
export interface StoreCalendar {
  tz: string;
  /** YYYY-MM-DD of an instant on the store's calendar. */
  key(d: Date): string;
  /** The instant a store day begins. */
  midnight(key: string): Date;
  weekStart(d: Date): Date;
  weekEnd(d: Date): Date;
}

export function storeCalendar(tz: string): StoreCalendar {
  return {
    tz,
    key: (d) => dateKeyInZone(d, tz),
    midnight: (k) => utcInstantOfLocalMidnight(k, tz),
    weekStart: (d) => startOfWeekInZone(d, tz),
    weekEnd: (d) => endOfWeekInZone(d, tz),
  };
}

/** The calendar a portal scope reads in: the scoped store's clock, or the
 *  client's when all its stores share one, else the org's. */
export async function portalCalendar(scope: {
  clientId: string;
  location: { timezone: string } | null;
}): Promise<StoreCalendar> {
  if (scope.location) return storeCalendar(scope.location.timezone);
  const zones = await prisma.location.findMany({
    where: { clientId: scope.clientId, deletedAt: null, isActive: true },
    select: { timezone: true },
    distinct: ['timezone'],
    take: 2,
  });
  return storeCalendar(zones.length === 1 ? zones[0]!.timezone : ORG_TZ);
}

export interface PortalScope {
  clientId: string;
  locationId: string | null;
  client: { id: string; name: string };
  location: {
    id: string;
    name: string;
    timezone: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
}

export function shiftScope(scope: PortalScope): Prisma.ShiftWhereInput {
  return {
    clientId: scope.clientId,
    publishedAt: { not: null },
    status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] },
    ...(scope.locationId ? { locationId: scope.locationId } : {}),
  };
}

/** Live clock-ins for the scope. A punch carries its own locationId
 *  (kiosk / geofence) or inherits its shift's. */
export function entryScope(scope: PortalScope): Prisma.TimeEntryWhereInput {
  return {
    clientId: scope.clientId,
    ...(scope.locationId
      ? {
          OR: [
            { locationId: scope.locationId },
            { shift: { is: { locationId: scope.locationId } } },
          ],
        }
      : {}),
  };
}

export function netMinutes(
  e: {
    clockInAt: Date;
    clockOutAt: Date | null;
    breaks: Array<{ startedAt: Date; endedAt: Date | null }>;
  },
  now: Date,
): number {
  const end = (e.clockOutAt ?? now).getTime();
  let ms = end - e.clockInAt.getTime();
  for (const b of e.breaks) {
    const bEnd = (b.endedAt ?? new Date(end)).getTime();
    ms -= Math.max(0, bEnd - b.startedAt.getTime());
  }
  return Math.max(0, ms / 60_000);
}

/* ---- Floor targets and hourly coverage ------------------------------- */

export interface TargetLocation {
  id: string;
  timezone: string;
  /** The store's TOTAL floor target (null label), if any. */
  total: number | null;
  /** Labeled windows in site-local minutes; end <= start wraps midnight. */
  windows: Array<{ label: string; start: number; end: number; count: number }>;
}

/** The scope's stores with their newest effective-dated targets, per
 *  (location, label). */
export async function loadTargets(scope: PortalScope, asOf: Date): Promise<TargetLocation[]> {
  const locations = await prisma.location.findMany({
    where: {
      clientId: scope.clientId,
      deletedAt: null,
      isActive: true,
      ...(scope.locationId ? { id: scope.locationId } : {}),
    },
    select: { id: true, timezone: true },
    take: 200,
  });
  if (locations.length === 0) return [];
  const rows = await prisma.staffingTarget.findMany({
    where: { locationId: { in: locations.map((l) => l.id) }, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: 'desc' },
    select: { locationId: true, targetCount: true, label: true, startMinute: true, endMinute: true },
    take: 2000,
  });
  const seen = new Set<string>();
  const byLoc = new Map<string, TargetLocation>(
    locations.map((l) => [l.id, { id: l.id, timezone: l.timezone, total: null, windows: [] }]),
  );
  for (const r of rows) {
    const key = `${r.locationId}|${r.label ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const loc = byLoc.get(r.locationId)!;
    if (r.label === null) loc.total = r.targetCount;
    else if (r.startMinute !== null && r.endMinute !== null) {
      loc.windows.push({ label: r.label, start: r.startMinute, end: r.endMinute, count: r.targetCount });
    }
  }
  return [...byLoc.values()];
}

/** Target for a site-local minute of day: the matching windows summed
 *  (windowed), else the total (not windowed), else null. */
export function targetAtMinute(
  loc: TargetLocation,
  minute: number,
): { target: number; windowed: boolean; labels: string[] } | null {
  const matching = loc.windows.filter((w) =>
    w.end > w.start ? minute >= w.start && minute < w.end : minute >= w.start || minute < w.end,
  );
  if (matching.length > 0) {
    return {
      target: matching.reduce((a, w) => a + w.count, 0),
      windowed: true,
      labels: matching.map((w) => w.label),
    };
  }
  if (loc.total !== null) return { target: loc.total, windowed: false, labels: [] };
  return null;
}

export interface HourCoverage {
  instant: Date;
  /** Contracted headcount for the hour across the scope. */
  target: number;
  /** People on the floor with punch evidence, capped at the target. */
  delivered: number;
}

/**
 * Delivered vs contracted, hour by hour — the time-integrated twin of the
 * hero's "6 / 8". An hour is GRADED when it falls inside a target window,
 * or, for a store with only a total target, when anything was scheduled
 * (so a 3am hour nobody planned for is not a miss). Delivered is the
 * distinct people with a time entry covering the top of the hour at the
 * scope, capped at the target — 40 on the floor against 30 is a full
 * hour, never extra credit. Only whole hours already in the past count.
 */
export function coverageByHours(opts: {
  locations: TargetLocation[];
  /** Store-scoped: attribute punches by location; client-wide: any punch at the client. */
  storeScoped: boolean;
  from: Date;
  to: Date;
  now: Date;
  shifts: Array<{ locationId: string | null; startsAt: Date; endsAt: Date }>;
  entries: Array<{
    associateId: string;
    locationId: string | null;
    clockInAt: Date;
    clockOutAt: Date | null;
  }>;
}): HourCoverage[] {
  const { locations, storeScoped, from, to, now, shifts, entries } = opts;
  if (locations.length === 0) return [];
  const hourFloor = (d: Date) => Math.floor(d.getTime() / HOUR) * HOUR;
  const start = hourFloor(from);
  const end = Math.min(hourFloor(to), hourFloor(now));
  if (end <= start) return [];
  const singleSite = locations.length === 1;

  // Pre-bucket: scheduled shifts per (location, hour) and punched people per hour.
  const scheduledAt = new Map<string, number>(); // `${locId}|${hourMs}`
  for (const s of shifts) {
    const locId = s.locationId ?? (singleSite ? locations[0]!.id : null);
    if (!locId) continue;
    for (let h = Math.max(start, hourFloor(s.startsAt)); h < Math.min(end, s.endsAt.getTime()); h += HOUR) {
      const key = `${locId}|${h}`;
      scheduledAt.set(key, (scheduledAt.get(key) ?? 0) + 1);
    }
  }
  const onFloorAt = new Map<string, Set<string>>(); // `${locId|*}|${hourMs}`
  for (const e of entries) {
    const outMs = (e.clockOutAt ?? now).getTime();
    const bucketLoc = storeScoped ? (e.locationId ?? (singleSite ? locations[0]!.id : null)) : '*';
    if (!bucketLoc) continue;
    for (let h = Math.max(start, hourFloor(e.clockInAt)); h < Math.min(end, outMs); h += HOUR) {
      if (e.clockInAt.getTime() > h) continue; // punched in after the top of the hour
      const key = `${bucketLoc}|${h}`;
      const set = onFloorAt.get(key) ?? new Set<string>();
      set.add(e.associateId);
      onFloorAt.set(key, set);
    }
  }

  const out: HourCoverage[] = [];
  for (let h = start; h < end; h += HOUR) {
    const instant = new Date(h);
    let target = 0;
    let graded = false;
    let deliveredStoreScoped = 0;
    for (const loc of locations) {
      const t = targetAtMinute(loc, zonedMinutes(instant, loc.timezone));
      if (!t) continue;
      const counts = t.windowed || (scheduledAt.get(`${loc.id}|${h}`) ?? 0) > 0;
      if (!counts) continue;
      graded = true;
      target += t.target;
      if (storeScoped) {
        deliveredStoreScoped += Math.min(t.target, onFloorAt.get(`${loc.id}|${h}`)?.size ?? 0);
      }
    }
    if (!graded || target === 0) continue;
    const delivered = storeScoped
      ? deliveredStoreScoped
      : Math.min(target, onFloorAt.get(`*|${h}`)?.size ?? 0);
    out.push({ instant, target, delivered });
  }
  return out;
}

/** The contracted headcount for "right now" — the hero's "/ 8". */
export async function currentTarget(
  scope: PortalScope,
  now: Date,
): Promise<{ target: number | null; label: string | null }> {
  const locations = await loadTargets(scope, now);
  let target = 0;
  let any = false;
  const labels = new Set<string>();
  for (const loc of locations) {
    const t = targetAtMinute(loc, zonedMinutes(now, loc.timezone));
    if (!t) continue;
    any = true;
    target += t.target;
    for (const l of t.labels) labels.add(l);
  }
  if (!any) return { target: null, label: null };
  return { target, label: labels.size === 1 ? [...labels][0]! : null };
}

/** The name the client sees on a "reviewed" mark: the reviewer's first
 *  name, else the account's mailbox name — never a bare email. */
export function reviewerName(
  u: { email: string; associate: { firstName: string } | null } | null,
): string | null {
  if (!u) return null;
  return u.associate?.firstName ?? u.email.split('@')[0] ?? null;
}

/** "Reviewed" marks for a client, keyed `${kind}|${key}`. */
export async function loadAcknowledgements(clientId: string) {
  const rows = await prisma.clientAcknowledgement.findMany({
    where: { clientId },
    include: { user: { select: { email: true, associate: { select: { firstName: true } } } } },
    take: 2000,
  });
  const map = new Map<string, { reviewedAt: string; reviewedBy: string | null }>();
  for (const r of rows) {
    map.set(`${r.kind}|${r.subjectKey}`, {
      reviewedAt: r.createdAt.toISOString(),
      reviewedBy: reviewerName(r.user),
    });
  }
  return (kind: 'STATEMENT' | 'SERVICE_REPORT', key: string) => map.get(`${kind}|${key}`) ?? null;
}

/**
 * The evidence layer shared by every historical lens: punches in a
 * window, matched to shifts by the link when it exists, else by the
 * assigned associate overlapping the shift (wrong kiosk still counts).
 */
export async function loadPunches(scope: PortalScope, from: Date, to: Date, now: Date) {
  const rows = await prisma.timeEntry.findMany({
    where: {
      ...entryScope(scope),
      status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] },
      clockInAt: { gte: new Date(from.getTime() - DAY), lt: to },
    },
    select: {
      associateId: true,
      shiftId: true,
      clockInAt: true,
      clockOutAt: true,
      locationId: true,
      shift: { select: { locationId: true } },
    },
    orderBy: { clockInAt: 'asc' },
    take: 20000,
  });
  const byShift = new Map<string, (typeof rows)[number]>();
  const byAssociate = new Map<string, typeof rows>();
  for (const e of rows) {
    if (e.shiftId && !byShift.has(e.shiftId)) byShift.set(e.shiftId, e);
    const list = byAssociate.get(e.associateId) ?? [];
    list.push(e);
    byAssociate.set(e.associateId, list);
  }
  type ShiftLike = { id: string; assignedAssociateId: string | null; startsAt: Date; endsAt: Date };
  const punchFor = (s: ShiftLike) =>
    byShift.get(s.id) ??
    (s.assignedAssociateId
      ? (byAssociate.get(s.assignedAssociateId) ?? []).find(
          (e) => e.clockInAt < s.endsAt && (e.clockOutAt ?? now) > s.startsAt,
        ) ?? null
      : null);
  const entries = rows.map((e) => ({
    associateId: e.associateId,
    locationId: e.locationId ?? e.shift?.locationId ?? null,
    clockInAt: e.clockInAt,
    clockOutAt: e.clockOutAt,
  }));
  return { punchFor, punched: (s: ShiftLike) => punchFor(s) !== null, entries };
}

/** Unexcused attendance events in a window, keyed the way the store
 *  scope needs (shiftId — the model carries no relation). */
/**
 * Safety rows this scope may count.
 *
 * A store manager's "days since last incident" is about their building.
 * Counting the whole client reset it on an injury at a store hours away,
 * which is both wrong and, on a safety board, corrosive. Rows recorded
 * before OshaIncident carried a store stay client-wide, so they only
 * reach client-wide accounts — an incident no one can place is not
 * attributed to a store that may not have had it.
 */
export function incidentWhere(scope: PortalScope): Prisma.OshaIncidentWhereInput {
  return {
    clientId: scope.clientId,
    ...(scope.locationId ? { locationId: scope.locationId } : {}),
  };
}

export function attendanceWhere(
  scope: PortalScope,
  from: Date,
  shiftIds: string[],
): Prisma.AttendanceEventWhereInput {
  return {
    clientId: scope.clientId,
    occurredOn: { gte: from },
    excusedAt: null,
    ...(scope.locationId ? { shiftId: { in: shiftIds } } : {}),
  };
}

/**
 * The reliability grade — did the store get the people it contracted for.
 *
 *   delivered vs contracted = Σ min(on the floor, target) ÷ Σ target,
 *                             over every graded hour in the period
 *
 * Targets are the store's floor targets (windows, else the total);
 * "on the floor" is punch evidence. Over-scheduling as a hedge is Alto's
 * cost, not the store's problem, so it never moves the grade — and 40 on
 * the floor against 30 is a full hour, never extra credit. Pooled over the
 * period (a busy week weighs more than a quiet one). When a store has no
 * floor target there is nothing to grade against, so the grade falls back
 * to the showed-up rate (punched shifts ÷ ended shifts) and says so.
 * Bands (owner decision 2026-09-16): A ≥ 88, B ≥ 70, F below 70.
 */
export type GradeBasis = 'contract' | 'schedule';
export function gradeWeeks(
  rows: Array<{ contracted: number; delivered: number; ended: number; showed: number }>,
): { grade: 'A' | 'B' | 'C' | 'D' | 'F' | null; score: number | null; basis: GradeBasis | null } {
  const contracted = rows.reduce((a, w) => a + w.contracted, 0);
  const delivered = rows.reduce((a, w) => a + w.delivered, 0);
  const ended = rows.reduce((a, w) => a + w.ended, 0);
  const showed = rows.reduce((a, w) => a + w.showed, 0);
  let score: number;
  let basis: GradeBasis;
  if (contracted > 0) {
    score = Math.round((delivered / contracted) * 100);
    basis = 'contract';
  } else if (ended > 0) {
    score = Math.round((showed / ended) * 100);
    basis = 'schedule';
  } else {
    return { grade: null, score: null, basis: null };
  }
  const grade = score >= 88 ? 'A' : score >= 70 ? 'B' : 'F';
  return { grade, score, basis };
}
