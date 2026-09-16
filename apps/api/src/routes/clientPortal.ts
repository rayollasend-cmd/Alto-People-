import { Router } from 'express';
import { z } from 'zod';
import { hasCapability, paidMinutesForRange } from '@alto-people/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';
import {
  orgDateKey,
  startOfWeekUTC,
  endOfWeekUTC,
  utcInstantOfLocalMidnight,
} from '../lib/timeAnomalies.js';
import { zonedMinutes } from '../lib/timezone.js';
import { enqueueAudit } from '../lib/audit.js';
import { ensureBrandingLoaded } from '../lib/branding.js';
import {
  buildClientServiceReport,
  renderClientServiceReportPdf,
} from '../lib/clientServiceReport.js';
import { renderStatementPdf } from '../lib/statementPdf.js';
import type { StatementSnapshot } from '../lib/clientStatement.js';

/**
 * The client portal — the store manager's site.
 *
 * One round trip answers the questions a store manager logs in to ask:
 * are we staffed against what we contracted right now, who is on my
 * floor, who is Alto's lead today and how do I reach them, did last
 * night's work get done (SOP evidence), what's tomorrow's risk, how
 * reliable has Alto been over the last month, is everyone on my floor
 * cleared, hours and money, and safety.
 *
 * SCOPE — a portal account is one of:
 *   - a STORE account (user.locationId set): every number is that one
 *     Location's; the page is titled with the store.
 *   - a CLIENT account (locationId null): the whole client, with a
 *     per-store roll-up strip for market / district managers.
 * CLIENT_PORTAL users are always clamped to their own client (and store
 * when provisioned) — ?clientId= / ?locationId= are ignored. Holders of
 * view:executive / manage:org preview any client via ?clientId= (and
 * optionally ?locationId=) — the pitch-demo path.
 *
 * PRIVACY INVARIANTS (tested in clientPortal.test.ts):
 *   - No pay or bill rates anywhere in the payload — statements expose
 *     only their frozen totals.
 *   - DRAFT statements and unpublished (draft) shifts are invisible.
 *   - Attendance incidents, clearance, and safety are COUNTS, never
 *     names: the client sees performance, not a person's file.
 *   - Nothing from another tenant, and nothing from another store for a
 *     store-scoped account.
 */

export const clientPortalRouter = Router();

const ORG_TZ = 'America/New_York';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function fullName(a: { firstName: string; lastName: string }): string {
  return `${a.firstName} ${a.lastName}`.trim();
}

/** Calendar-day arithmetic through the key (not +24h) so DST days keep
 *  their local-midnight boundaries. */
function nextKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

interface PortalScope {
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

/**
 * Resolve who the caller is looking at. Fails closed for a portal
 * account without a client; 404s when the preview target doesn't exist
 * or the store isn't under the client.
 */
async function resolveScope(
  user: SessionUser,
  query: { clientId?: unknown; locationId?: unknown },
): Promise<PortalScope> {
  let clientId: string;
  let locationId: string | null = null;
  if (user.role === 'CLIENT_PORTAL') {
    // Always clamped to their own client + store — query params ignored.
    if (!user.clientId) {
      throw new HttpError(
        403,
        'no_client_assigned',
        'No client is linked to this portal account yet — ask your Alto contact.',
      );
    }
    clientId = user.clientId;
    // A store account is pinned to its store. A client-wide (market)
    // account may DRILL INTO one of its own stores via ?locationId= —
    // validated below to belong to the same client, so it can never widen.
    locationId =
      user.locationId ??
      (typeof query.locationId === 'string' && query.locationId ? query.locationId : null);
  } else if (
    hasCapability(user.role, 'view:executive') ||
    hasCapability(user.role, 'manage:org')
  ) {
    const requested = query.clientId;
    if (typeof requested !== 'string' || !requested) {
      throw new HttpError(400, 'client_required', 'Pass ?clientId= to preview a client portal.');
    }
    clientId = requested;
    locationId =
      typeof query.locationId === 'string' && query.locationId ? query.locationId : null;
  } else {
    throw new HttpError(403, 'forbidden', 'The client portal is for client accounts.');
  }

  const client = await prisma.client.findFirst({
    where: { id: clientId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');

  let location: PortalScope['location'] = null;
  if (locationId) {
    location = await prisma.location.findFirst({
      where: { id: locationId, clientId, deletedAt: null },
      select: {
        id: true,
        name: true,
        timezone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        zip: true,
      },
    });
    if (!location) throw new HttpError(404, 'location_not_found', 'Store not found');
  }
  return { clientId, locationId: location ? location.id : null, client, location };
}

/** Shift where-clause for the scope: published, live statuses, and the
 *  store when scoped. Store scope is STRICT on locationId — a site-less
 *  shift belongs to the client, not to any one store. */
function shiftScope(scope: PortalScope): Prisma.ShiftWhereInput {
  return {
    clientId: scope.clientId,
    publishedAt: { not: null },
    status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] },
    ...(scope.locationId ? { locationId: scope.locationId } : {}),
  };
}

/** Live clock-ins for the scope. A punch carries its own locationId
 *  (kiosk / geofence) or inherits its shift's. */
function entryScope(scope: PortalScope): Prisma.TimeEntryWhereInput {
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

function netMinutes(
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

interface TargetLocation {
  id: string;
  timezone: string;
  /** The store's TOTAL floor target (null label), if any. */
  total: number | null;
  /** Labeled windows in site-local minutes; end <= start wraps midnight. */
  windows: Array<{ label: string; start: number; end: number; count: number }>;
}

/** The scope's stores with their newest effective-dated targets, per
 *  (location, label). */
async function loadTargets(scope: PortalScope, asOf: Date): Promise<TargetLocation[]> {
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
function targetAtMinute(
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

interface HourCoverage {
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
function coverageByHours(opts: {
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
async function currentTarget(
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
function reviewerName(
  u: { email: string; associate: { firstName: string } | null } | null,
): string | null {
  if (!u) return null;
  return u.associate?.firstName ?? u.email.split('@')[0] ?? null;
}

/** "Reviewed" marks for a client, keyed `${kind}|${key}`. */
async function loadAcknowledgements(clientId: string) {
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
async function loadPunches(scope: PortalScope, from: Date, to: Date, now: Date) {
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
function attendanceWhere(
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
 * Bands: A ≥ 98, B ≥ 95, C ≥ 90, D ≥ 85.
 */
type GradeBasis = 'contract' | 'schedule';
function gradeWeeks(
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
  const grade = score >= 98 ? 'A' : score >= 95 ? 'B' : score >= 90 ? 'C' : score >= 85 ? 'D' : 'F';
  return { grade, score, basis };
}

type RosterState = 'open' | 'on-floor' | 'done' | 'confirmed' | 'unconfirmed';

clientPortalRouter.get('/client-portal/overview', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query);
    const { clientId } = scope;

    const now = new Date();
    const todayKey = orgDateKey(now);
    const todayStart = utcInstantOfLocalMidnight(todayKey, ORG_TZ);
    const tomorrowStart = utcInstantOfLocalMidnight(nextKey(todayKey, 1), ORG_TZ);
    const dayAfterStart = utcInstantOfLocalMidnight(nextKey(todayKey, 2), ORG_TZ);
    const weekStart = startOfWeekUTC(now);
    const weekEnd = endOfWeekUTC(now);
    // Reliability window: the 4 completed weeks before this one, plus
    // this one (rendered separately as "so far").
    const trendStart = new Date(weekStart.getTime() - 4 * 7 * DAY);
    const monthStart = utcInstantOfLocalMidnight(`${todayKey.slice(0, 7)}-01`, ORG_TZ);
    const yesterdayKey = nextKey(todayKey, -1);

    const shifts = shiftScope(scope);
    const entries = entryScope(scope);
    const shiftRel = scope.locationId ? { locationId: scope.locationId } : {};

    const [
      onFloorEntries,
      todayShifts,
      trendShifts,
      tomorrowShifts,
      statements,
      trendClaims,
      pendingTomorrowClaims,
      weekEntries,
      leadUsers,
      leadPositions,
      opsShifts,
      orgSetting,
      monthIncidents,
      openIncidents,
      lastIncident,
      target,
      stores,
    ] = await Promise.all([
      prisma.timeEntry.findMany({
        where: { ...entries, status: 'ACTIVE' },
        select: {
          clockInAt: true,
          associateId: true,
          associate: { select: { id: true, firstName: true, lastName: true } },
          shift: { select: { position: true } },
        },
        orderBy: { clockInAt: 'asc' },
        take: 200,
      }),
      prisma.shift.findMany({
        where: { ...shifts, startsAt: { lt: tomorrowStart }, endsAt: { gt: todayStart } },
        select: {
          id: true,
          position: true,
          startsAt: true,
          endsAt: true,
          status: true,
          acknowledgedAt: true,
          assignedAssociateId: true,
          assignedAssociate: { select: { firstName: true, lastName: true } },
          locationRel: { select: { name: true, timezone: true } },
        },
        orderBy: { startsAt: 'asc' },
        take: 300,
      }),
      prisma.shift.findMany({
        where: { ...shifts, startsAt: { gte: trendStart, lt: weekEnd } },
        select: { id: true, locationId: true, startsAt: true, endsAt: true, status: true, assignedAssociateId: true },
        take: 5000,
      }),
      prisma.shift.findMany({
        where: { ...shifts, startsAt: { gte: tomorrowStart, lt: dayAfterStart } },
        select: { status: true, acknowledgedAt: true },
        take: 500,
      }),
      prisma.clientStatement.findMany({
        where: { clientId, status: 'FINAL' },
        orderBy: { periodEnd: 'desc' },
        take: 6,
        select: {
          id: true,
          number: true,
          periodStart: true,
          periodEnd: true,
          finalizedAt: true,
          paidAt: true,
          snapshot: true,
        },
      }),
      prisma.openShiftClaim.findMany({
        where: {
          status: 'APPROVED',
          decidedAt: { gte: trendStart },
          shift: { clientId, ...shiftRel },
        },
        select: { decidedAt: true },
        take: 2000,
      }),
      // Tomorrow's OPEN shifts with a claim waiting on approval: cover
      // is in flight even though the slot still reads "open".
      prisma.openShiftClaim.findMany({
        where: {
          status: 'PENDING',
          shift: {
            ...shifts,
            status: 'OPEN',
            startsAt: { gte: tomorrowStart, lt: dayAfterStart },
          },
        },
        select: { shiftId: true },
        take: 500,
      }),
      prisma.timeEntry.findMany({
        where: {
          ...entries,
          status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] },
          clockInAt: { gte: weekStart, lt: weekEnd },
        },
        select: {
          clockInAt: true,
          clockOutAt: true,
          breaks: { select: { startedAt: true, endedAt: true } },
        },
        take: 5000,
      }),
      // Alto's leadership at this store: the supervisor accounts bound to
      // the client. Phone rides on the linked associate record.
      prisma.user.findMany({
        where: {
          clientId,
          status: 'ACTIVE',
          deletedAt: null,
          role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] },
        },
        select: {
          id: true,
          email: true,
          role: true,
          associateId: true,
          associate: { select: { id: true, firstName: true, lastName: true, phone: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 6,
      }),
      prisma.shiftPosition.findMany({
        where: { clientId, isLead: true, deletedAt: null },
        select: { name: true },
        take: 50,
      }),
      prisma.opsShift.findMany({
        where: { clientId, dateKey: { in: [yesterdayKey, todayKey] } },
        select: {
          id: true,
          dateKey: true,
          department: true,
          period: true,
          status: true,
          openedById: true,
          openedAt: true,
          closedAt: true,
          sopDone: true,
          sopTotal: true,
          taskDone: true,
          taskTotal: true,
          tempAlerts: true,
          closedIncomplete: true,
          closingSummary: true,
          _count: { select: { tasks: { where: { photos: { some: {} } } } } },
        },
        orderBy: { openedAt: 'desc' },
        take: 40,
      }),
      prisma.orgSetting.findUnique({
        where: { id: 'singleton' },
        select: { supportEmail: true },
      }),
      prisma.oshaIncident.count({ where: { clientId, occurredAt: { gte: monthStart } } }),
      prisma.oshaIncident.count({ where: { clientId, status: { not: 'RESOLVED' } } }),
      prisma.oshaIncident.findFirst({
        where: { clientId, occurredAt: { gte: new Date(now.getTime() - 365 * DAY) } },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
      currentTarget(scope, now),
      scope.locationId
        ? Promise.resolve([])
        : prisma.location.findMany({
            where: { clientId, deletedAt: null, isActive: true },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
            take: 100,
          }),
    ]);

    const [trendEvents, { punched, entries: trendEntries }, targetLocations] = await Promise.all([
      prisma.attendanceEvent.findMany({
        where: attendanceWhere(scope, trendStart, trendShifts.map((s) => s.id)),
        select: { kind: true, occurredOn: true, shiftId: true },
        take: 2000,
      }),
      loadPunches(scope, trendStart, weekEnd, now),
      loadTargets(scope, now),
    ]);
    const trendHours = coverageByHours({
      locations: targetLocations,
      storeScoped: !!scope.locationId,
      from: trendStart,
      to: weekEnd,
      now,
      shifts: trendShifts,
      entries: trendEntries,
    });
    const ncnsShiftIds = new Set(
      trendEvents.filter((e) => e.kind === 'NO_CALL_NO_SHOW' && e.shiftId).map((e) => e.shiftId),
    );

    const onFloorIds = new Set(onFloorEntries.map((e) => e.associateId));
    // Punch time per person on the floor — shown next to the name on the
    // Today page. A time, never a "late" label: the judgment stays with Alto.
    const clockInByAssociate = new Map(
      onFloorEntries.map((e) => [e.associateId, e.clockInAt.toISOString()]),
    );
    const leadNames = new Set(leadPositions.map((p) => p.name));

    const roster = todayShifts.map((s) => {
      const done = s.status === 'COMPLETED' || s.endsAt.getTime() <= now.getTime();
      const onFloor = s.assignedAssociateId !== null && onFloorIds.has(s.assignedAssociateId);
      const state: RosterState =
        s.status === 'OPEN'
          ? 'open'
          : onFloor
            ? 'on-floor'
            : done
              ? 'done'
              : s.acknowledgedAt
                ? 'confirmed'
                : 'unconfirmed';
      return {
        shiftId: s.id,
        associateId: s.assignedAssociateId,
        name: s.assignedAssociate ? fullName(s.assignedAssociate) : null,
        position: s.position,
        isLead: leadNames.has(s.position),
        clockInAt:
          onFloor && s.assignedAssociateId
            ? (clockInByAssociate.get(s.assignedAssociateId) ?? null)
            : null,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        timezone: s.locationRel?.timezone ?? ORG_TZ,
        locationName: s.locationRel?.name ?? null,
        state,
      };
    });

    // ---- Week shape + reliability trend (org weeks, Sat→Fri) ----------
    const weekKeyOf = (d: Date) => orgDateKey(startOfWeekUTC(d));
    const thisWeekKey = orgDateKey(weekStart);
    const weekKeys: string[] = [];
    for (let i = 4; i >= 0; i--) {
      weekKeys.push(orgDateKey(new Date(weekStart.getTime() - i * 7 * DAY)));
    }
    const weekAgg = new Map(
      weekKeys.map((k) => [
        k,
        {
          start: k,
          filled: 0,
          total: 0,
          ended: 0,
          showed: 0,
          contracted: 0,
          delivered: 0,
          noCallNoShows: 0,
          callOuts: 0,
          lates: 0,
          replaced: 0,
        },
      ]),
    );
    const dayKeys: string[] = [];
    for (let i = 0; i < 7; i++) dayKeys.push(nextKey(thisWeekKey, i));
    const dayMap = new Map(dayKeys.map((k) => [k, { date: k, filled: 0, open: 0 }]));
    let weekMinutes = 0;
    const weekAssociateIds = new Set<string>();
    for (const s of trendShifts) {
      const wk = weekAgg.get(weekKeyOf(s.startsAt));
      if (wk) {
        wk.total += 1;
        if (s.status !== 'OPEN') wk.filled += 1;
        if (s.endsAt.getTime() <= now.getTime()) {
          wk.ended += 1;
          if (s.status !== 'OPEN' && !ncnsShiftIds.has(s.id) && punched(s)) wk.showed += 1;
        }
      }
      if (s.startsAt >= weekStart) {
        const bucket = dayMap.get(orgDateKey(s.startsAt));
        if (bucket) {
          if (s.status === 'OPEN') bucket.open += 1;
          else bucket.filled += 1;
        }
        weekMinutes += paidMinutesForRange(s.startsAt, s.endsAt);
        if (s.assignedAssociateId) weekAssociateIds.add(s.assignedAssociateId);
      }
    }
    for (const e of trendEvents) {
      const wk = weekAgg.get(weekKeyOf(e.occurredOn));
      if (!wk) continue;
      if (e.kind === 'NO_CALL_NO_SHOW') wk.noCallNoShows += 1;
      else if (e.kind === 'CALL_OUT') wk.callOuts += 1;
      else if (e.kind === 'LATE') wk.lates += 1;
    }
    for (const c of trendClaims) {
      if (!c.decidedAt) continue;
      const wk = weekAgg.get(weekKeyOf(c.decidedAt));
      if (wk) wk.replaced += 1;
    }
    for (const h of trendHours) {
      const wk = weekAgg.get(weekKeyOf(h.instant));
      if (!wk) continue;
      wk.contracted += h.target;
      wk.delivered += h.delivered;
    }
    const weeks = weekKeys.map((k) => {
      const w = weekAgg.get(k)!;
      return {
        ...w,
        end: nextKey(k, 6),
        fillPct: w.total > 0 ? Math.round((w.filled / w.total) * 100) : null,
        // The graded figure: delivered vs contracted, else the showed-up rate.
        reliabilityPct:
          w.contracted > 0
            ? Math.round((w.delivered / w.contracted) * 100)
            : w.ended > 0
              ? Math.round((w.showed / w.ended) * 100)
              : null,
        showedUpPct: w.ended > 0 ? Math.round((w.showed / w.ended) * 100) : null,
        current: k === thisWeekKey,
      };
    });
    const completedWeeks = weeks.filter((w) => !w.current);
    const graded = gradeWeeks(
      completedWeeks.some((w) => w.total > 0) ? completedWeeks : weeks,
    );
    const thisWeek = weekAgg.get(thisWeekKey)!;

    // ---- Clearance: this week's crew, counts only ----------------------
    const crewIds = [...weekAssociateIds];
    let clearance = { total: 0, i9Complete: 0, checksInFlight: 0, flagged: 0 };
    if (crewIds.length > 0) {
      const [bg, dt, i9] = await Promise.all([
        prisma.backgroundCheck.findMany({
          where: { associateId: { in: crewIds } },
          orderBy: { initiatedAt: 'desc' },
          select: { associateId: true, status: true },
          take: 5000,
        }),
        prisma.drugTest.findMany({
          where: { associateId: { in: crewIds } },
          orderBy: { initiatedAt: 'desc' },
          select: { associateId: true, status: true },
          take: 5000,
        }),
        prisma.i9Verification.findMany({
          where: { associateId: { in: crewIds }, section2CompletedAt: { not: null } },
          select: { associateId: true },
          take: 5000,
        }),
      ]);
      const latest = (rows: Array<{ associateId: string; status: string }>) => {
        const m = new Map<string, string>();
        for (const r of rows) if (!m.has(r.associateId)) m.set(r.associateId, r.status);
        return m;
      };
      const bgLatest = latest(bg);
      const dtLatest = latest(dt);
      const i9Done = new Set(i9.map((r) => r.associateId));
      const inFlight = new Set(['INITIATED', 'IN_PROGRESS']);
      const bad = new Set(['FAILED', 'NEEDS_REVIEW']);
      let i9Complete = 0;
      let checksInFlight = 0;
      let flagged = 0;
      for (const id of crewIds) {
        if (i9Done.has(id)) i9Complete += 1;
        const statuses = [bgLatest.get(id), dtLatest.get(id)].filter(
          (s): s is string => !!s,
        );
        if (statuses.some((s) => bad.has(s))) flagged += 1;
        else if (statuses.some((s) => inFlight.has(s))) checksInFlight += 1;
      }
      clearance = { total: crewIds.length, i9Complete, checksInFlight, flagged };
    }

    // ---- Alto leadership on site ----------------------------------------
    const opsRunners = new Set(
      opsShifts.filter((o) => o.dateKey === todayKey && o.status === 'ACTIVE').map((o) => o.openedById),
    );
    const leads = leadUsers.map((u) => ({
      name: u.associate ? fullName(u.associate) : u.email.split('@')[0] ?? u.email,
      phone: u.associate?.phone ?? null,
      email: u.email,
      title: u.role === 'SHIFT_SUPERVISOR' ? ('supervisor' as const) : ('floor-lead' as const),
      onFloor: !!u.associateId && onFloorIds.has(u.associateId),
      runningOps: opsRunners.has(u.id),
    }));

    // ---- Store ops evidence: yesterday + today --------------------------
    const opsDay = (key: string) => {
      const rows = opsShifts.filter((o) => o.dateKey === key);
      if (rows.length === 0) return null;
      const sum = (f: (o: (typeof rows)[number]) => number) => rows.reduce((a, o) => a + f(o), 0);
      return {
        dateKey: key,
        shifts: rows.length,
        open: rows.filter((o) => o.status === 'ACTIVE').length,
        sopDone: sum((o) => o.sopDone),
        sopTotal: sum((o) => o.sopTotal),
        taskDone: sum((o) => o.taskDone),
        taskTotal: sum((o) => o.taskTotal),
        tempAlerts: sum((o) => o.tempAlerts),
        incomplete: rows.filter((o) => o.closedIncomplete).length,
        photos: sum((o) => o._count.tasks),
        notes: rows
          .filter((o) => o.closingSummary)
          .slice(0, 3)
          .map((o) => ({
            department: o.department,
            period: o.period,
            summary: o.closingSummary!,
          })),
      };
    };

    // ---- Per-store roll-up for client-wide accounts ---------------------
    let storeRows: Array<{
      id: string;
      name: string;
      onFloor: number;
      scheduledNow: number;
      openToday: number;
    }> = [];
    if (!scope.locationId && stores.length > 1) {
      const [entriesByLoc, shiftsByLoc] = await Promise.all([
        prisma.timeEntry.findMany({
          where: { clientId, status: 'ACTIVE' },
          select: { locationId: true, shift: { select: { locationId: true } } },
          take: 500,
        }),
        prisma.shift.findMany({
          where: { ...shifts, startsAt: { lt: tomorrowStart }, endsAt: { gt: todayStart } },
          select: { locationId: true, status: true, startsAt: true, endsAt: true },
          take: 1000,
        }),
      ]);
      storeRows = stores.map((l) => ({
        id: l.id,
        name: l.name,
        onFloor: entriesByLoc.filter((e) => (e.locationId ?? e.shift?.locationId) === l.id).length,
        scheduledNow: shiftsByLoc.filter(
          (s) =>
            s.locationId === l.id &&
            s.status !== 'OPEN' &&
            s.startsAt.getTime() <= now.getTime() &&
            s.endsAt.getTime() > now.getTime(),
        ).length,
        openToday: shiftsByLoc.filter((s) => s.locationId === l.id && s.status === 'OPEN').length,
      }));
    }

    const workedMinutes = weekEntries.reduce((a, e) => a + netMinutes(e, now), 0);
    const reviewed = await loadAcknowledgements(clientId);
    const lastCompletedWeek = orgDateKey(new Date(weekStart.getTime() - 7 * DAY));
    const preview = req.user!.role !== 'CLIENT_PORTAL';
    const previewQs = preview
      ? `clientId=${encodeURIComponent(clientId)}${scope.locationId ? `&locationId=${encodeURIComponent(scope.locationId)}` : ''}`
      : '';
    const withPreview = (url: string) =>
      previewQs ? `${url}${url.includes('?') ? '&' : '?'}${previewQs}` : url;

    res.json({
      client: { id: scope.client.id, name: scope.client.name },
      store: scope.location
        ? {
            id: scope.location.id,
            name: scope.location.name,
            timezone: scope.location.timezone,
            address:
              [
                scope.location.addressLine1,
                scope.location.addressLine2,
                [scope.location.city, scope.location.state].filter(Boolean).join(', ') +
                  (scope.location.zip ? ` ${scope.location.zip}` : ''),
              ]
                .map((s) => (s ?? '').trim())
                .filter(Boolean)
                .join(' · ') || null,
          }
        : null,
      stores: storeRows,
      generatedAt: now.toISOString(),
      now: {
        onFloor: onFloorEntries.map((e) => ({
          associateId: e.associate.id,
          name: fullName(e.associate),
          position: e.shift?.position ?? null,
          isLead: !!e.shift?.position && leadNames.has(e.shift.position),
          clockInAt: e.clockInAt.toISOString(),
        })),
        scheduledNow: todayShifts.filter(
          (s) =>
            s.status !== 'OPEN' &&
            s.startsAt.getTime() <= now.getTime() &&
            s.endsAt.getTime() > now.getTime(),
        ).length,
        target: target.target,
        targetLabel: target.label,
      },
      today: {
        date: todayKey,
        roster,
        filled: roster.filter((r) => r.state !== 'open').length,
        open: roster.filter((r) => r.state === 'open').length,
      },
      week: {
        start: thisWeekKey,
        end: nextKey(thisWeekKey, 6),
        days: dayKeys.map((k) => dayMap.get(k)!),
        filled: thisWeek.filled,
        open: thisWeek.total - thisWeek.filled,
        fillRatePct:
          thisWeek.total > 0 ? Math.round((thisWeek.filled / thisWeek.total) * 100) : null,
        hours: Math.round((weekMinutes / 60) * 10) / 10,
        workedHours: Math.round((workedMinutes / 60) * 10) / 10,
      },
      tomorrow: {
        confirmed: tomorrowShifts.filter((s) => s.status === 'ASSIGNED' && s.acknowledgedAt !== null)
          .length,
        unconfirmed: tomorrowShifts.filter(
          (s) => s.status === 'ASSIGNED' && s.acknowledgedAt === null,
        ).length,
        open: tomorrowShifts.filter((s) => s.status === 'OPEN').length,
        coverInFlight: new Set(pendingTomorrowClaims.map((c) => c.shiftId)).size,
      },
      leads: { people: leads, supportEmail: orgSetting?.supportEmail ?? null },
      ops:
        opsShifts.length > 0
          ? { yesterday: opsDay(yesterdayKey), today: opsDay(todayKey) }
          : null,
      reliability: { weeks, grade: graded.grade, score: graded.score, basis: graded.basis },
      clearance,
      statements: statements.map((st) => {
        const snap = st.snapshot as {
          totals?: { amount?: number; hours?: number };
          stores?: Array<{ locationName: string; hours: number; amount: number }>;
        } | null;
        const storeLine = scope.location
          ? (snap?.stores ?? []).find((s) => s.locationName === scope.location!.name) ?? null
          : null;
        return {
          id: st.id,
          number: st.number,
          periodStart: st.periodStart.toISOString().slice(0, 10),
          periodEnd: st.periodEnd.toISOString().slice(0, 10),
          amount: snap?.totals?.amount ?? null,
          hours: snap?.totals?.hours ?? null,
          storeHours: storeLine ? storeLine.hours : null,
          storeAmount: storeLine ? storeLine.amount : null,
          finalizedAt: st.finalizedAt ? st.finalizedAt.toISOString() : null,
          paidAt: st.paidAt ? st.paidAt.toISOString() : null,
          pdfUrl: withPreview(`/api/client-portal/statements/${st.id}.pdf`),
          reviewed: reviewed('STATEMENT', st.id),
        };
      }),
      coverage: {
        weekStart: thisWeekKey,
        noCallNoShows: thisWeek.noCallNoShows,
        callOuts: thisWeek.callOuts,
        lates: thisWeek.lates,
        replacementsFound: thisWeek.replaced,
      },
      safety: {
        monthIncidents,
        open: openIncidents,
        daysSinceLast: lastIncident
          ? Math.floor((now.getTime() - lastIncident.occurredAt.getTime()) / DAY)
          : null,
      },
      serviceReport: {
        weekStart: lastCompletedWeek,
        url: withPreview(`/api/client-portal/service-report.pdf?week=${lastCompletedWeek}`),
        reviewed: reviewed('SERVICE_REPORT', lastCompletedWeek),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /client-portal/schedule?week=YYYY-MM-DD
 * The store's published week (Sat→Fri), day by day, no rates. `week` is
 * any date inside the desired org week; omitted = this week.
 */
clientPortalRouter.get('/client-portal/schedule', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query);
    const weekParam = req.query.week?.toString();
    if (weekParam && !/^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
      throw new HttpError(400, 'invalid_week', '`week` must be YYYY-MM-DD');
    }
    const anchor = weekParam ? new Date(`${weekParam}T12:00:00.000Z`) : new Date();
    const weekStart = startOfWeekUTC(anchor);
    const weekEnd = endOfWeekUTC(anchor);
    const now = new Date();
    const startKey = orgDateKey(weekStart);

    const [rows, live] = await Promise.all([
      prisma.shift.findMany({
        where: { ...shiftScope(scope), startsAt: { gte: weekStart, lt: weekEnd } },
        select: {
          id: true,
          position: true,
          startsAt: true,
          endsAt: true,
          status: true,
          acknowledgedAt: true,
          assignedAssociateId: true,
          assignedAssociate: { select: { firstName: true, lastName: true } },
          locationRel: { select: { name: true, timezone: true } },
        },
        orderBy: { startsAt: 'asc' },
        take: 2000,
      }),
      prisma.timeEntry.findMany({
        where: { ...entryScope(scope), status: 'ACTIVE' },
        select: { associateId: true },
        take: 500,
      }),
    ]);
    const onFloor = new Set(live.map((e) => e.associateId));
    const days = new Map<string, Array<Record<string, unknown>>>();
    for (let i = 0; i < 7; i++) days.set(nextKey(startKey, i), []);
    for (const s of rows) {
      const list = days.get(orgDateKey(s.startsAt));
      if (!list) continue;
      const done = s.status === 'COMPLETED' || s.endsAt.getTime() <= now.getTime();
      const state: RosterState =
        s.status === 'OPEN'
          ? 'open'
          : s.assignedAssociateId && onFloor.has(s.assignedAssociateId)
            ? 'on-floor'
            : done
              ? 'done'
              : s.acknowledgedAt
                ? 'confirmed'
                : 'unconfirmed';
      list.push({
        shiftId: s.id,
        associateId: s.assignedAssociateId,
        name: s.assignedAssociate ? fullName(s.assignedAssociate) : null,
        position: s.position,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        timezone: s.locationRel?.timezone ?? ORG_TZ,
        locationName: s.locationRel?.name ?? null,
        state,
      });
    }
    res.json({
      client: { id: scope.client.id, name: scope.client.name },
      store: scope.location ? { id: scope.location.id, name: scope.location.name } : null,
      week: { start: startKey, end: nextKey(startKey, 6) },
      days: [...days.entries()].map(([date, shifts]) => ({ date, shifts })),
      filled: rows.filter((r) => r.status !== 'OPEN').length,
      open: rows.filter((r) => r.status === 'OPEN').length,
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /client-portal/service-report.pdf?week=YYYY-MM-DD
 * The weekly service report, downloaded by the client themselves. Same
 * builder Alto uses from the Clients page, clamped to the caller's
 * client. Omitted week = the last completed one.
 */
clientPortalRouter.get(
  '/client-portal/service-report.pdf',
  requireAuth,
  async (req, res, next) => {
    try {
      const scope = await resolveScope(req.user!, req.query);
      const weekParam = req.query.week?.toString();
      if (weekParam && !/^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
        throw new HttpError(400, 'invalid_week', '`week` must be YYYY-MM-DD');
      }
      const weekStart = weekParam
        ? startOfWeekUTC(new Date(`${weekParam}T12:00:00.000Z`))
        : new Date(startOfWeekUTC(new Date()).getTime() - 7 * DAY);
      const branding = await ensureBrandingLoaded(prisma);
      const data = await buildClientServiceReport(
        prisma,
        scope.clientId,
        weekStart,
        branding.orgName,
      );
      const pdf = await renderClientServiceReportPdf(data);
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          clientId: scope.clientId,
          action: 'client.service_report_exported',
          entityType: 'Client',
          entityId: scope.clientId,
          metadata: { periodStart: data.periodStart, periodEnd: data.periodEnd, via: 'portal' },
        },
        'clients.service_report',
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="service-report-${scope.client.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${data.periodStart}.pdf"`,
      );
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /client-portal/statements/:sid.pdf — a FINAL statement, as the
 * invoice PDF. Drafts don't exist for the client (404), and another
 * tenant's statement id is simply not found.
 */
clientPortalRouter.get(
  '/client-portal/statements/:sid.pdf',
  requireAuth,
  async (req, res, next) => {
    try {
      const scope = await resolveScope(req.user!, req.query);
      const row = await prisma.clientStatement.findFirst({
        where: { id: req.params.sid, clientId: scope.clientId, status: 'FINAL' },
        include: { finalizedBy: { select: { email: true } } },
      });
      if (!row) throw new HttpError(404, 'not_found', 'Statement not found');
      const [branding, client] = await Promise.all([
        ensureBrandingLoaded(prisma),
        prisma.client.findUnique({
          where: { id: scope.clientId },
          select: {
            legalName: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            zip: true,
          },
        }),
      ]);
      const pdf = await renderStatementPdf({
        snapshot: row.snapshot as unknown as StatementSnapshot,
        number: row.number,
        status: row.status,
        finalizedAt: row.finalizedAt,
        finalizedByEmail: row.finalizedBy?.email ?? null,
        orgName: branding.orgName,
        billTo: client,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="statement-${row.periodStart.toISOString().slice(0, 10)}${
          row.number !== null ? `-no${String(row.number).padStart(4, '0')}` : ''
        }.pdf"`,
      );
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  },
);

/* ====================================================================== */
/* The historical lenses: a day, and a range.                              */
/* ====================================================================== */

type DayState =
  | 'open'
  | 'on-floor'
  | 'worked'
  | 'missed'
  | 'not-in'
  | 'confirmed'
  | 'unconfirmed';

function parseDayKey(raw: unknown, name: string): string {
  const s = typeof raw === 'string' ? raw : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new HttpError(400, `invalid_${name}`, `\`${name}\` must be YYYY-MM-DD`);
  }
  return s;
}

/**
 * GET /client-portal/day?date=YYYY-MM-DD
 * One day, wave by wave, from the punch record: who worked (in/out
 * times), who was expected and never punched, who is on the floor right
 * now (today), unfilled slots. Past, present and future read from the
 * same route so "2 days ago" looks exactly like today did at close.
 */
clientPortalRouter.get('/client-portal/day', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query);
    const now = new Date();
    const dateKey = req.query.date === undefined ? orgDateKey(now) : parseDayKey(req.query.date, 'date');
    const dayStart = utcInstantOfLocalMidnight(dateKey, ORG_TZ);
    const dayEnd = utcInstantOfLocalMidnight(nextKey(dateKey, 1), ORG_TZ);

    const [rows, leadPositions, { punchFor }, target] = await Promise.all([
      prisma.shift.findMany({
        where: { ...shiftScope(scope), startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
        select: {
          id: true,
          position: true,
          startsAt: true,
          endsAt: true,
          status: true,
          acknowledgedAt: true,
          assignedAssociateId: true,
          assignedAssociate: { select: { firstName: true, lastName: true } },
          locationRel: { select: { name: true, timezone: true } },
        },
        orderBy: { startsAt: 'asc' },
        take: 300,
      }),
      prisma.shiftPosition.findMany({
        where: { clientId: scope.clientId, isLead: true, deletedAt: null },
        select: { name: true },
        take: 50,
      }),
      loadPunches(scope, dayStart, dayEnd, now),
      currentTarget(scope, now),
    ]);
    const ncns = new Set(
      (
        await prisma.attendanceEvent.findMany({
          where: {
            ...attendanceWhere(scope, dayStart, rows.map((s) => s.id)),
            kind: 'NO_CALL_NO_SHOW',
            shiftId: { in: rows.map((s) => s.id) },
          },
          select: { shiftId: true },
          take: 500,
        })
      ).map((e) => e.shiftId),
    );
    const leadNames = new Set(leadPositions.map((p) => p.name));

    const roster = rows.map((s) => {
      const punch = s.status === 'OPEN' ? null : punchFor(s);
      const ended = s.endsAt.getTime() <= now.getTime();
      const started = s.startsAt.getTime() <= now.getTime();
      let state: DayState;
      if (s.status === 'OPEN') state = 'open';
      else if (ncns.has(s.id)) state = 'missed';
      else if (punch && punch.clockOutAt === null && !ended) state = 'on-floor';
      else if (punch) state = 'worked';
      else if (ended) state = 'missed';
      else if (started) state = 'not-in';
      else state = s.acknowledgedAt ? 'confirmed' : 'unconfirmed';
      return {
        shiftId: s.id,
        associateId: s.assignedAssociateId,
        name: s.assignedAssociate ? fullName(s.assignedAssociate) : null,
        position: s.position,
        isLead: leadNames.has(s.position),
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        timezone: s.locationRel?.timezone ?? ORG_TZ,
        locationName: s.locationRel?.name ?? null,
        state,
        clockInAt: punch && state !== 'missed' ? punch.clockInAt.toISOString() : null,
        clockOutAt: punch && state === 'worked' ? (punch.clockOutAt?.toISOString() ?? null) : null,
      };
    });

    res.json({
      client: { id: scope.client.id, name: scope.client.name },
      store: scope.location
        ? { id: scope.location.id, name: scope.location.name, timezone: scope.location.timezone }
        : null,
      date: dateKey,
      today: orgDateKey(now),
      generatedAt: now.toISOString(),
      target: target.target,
      roster,
      summary: {
        expected: roster.filter((r) => r.state !== 'open').length,
        worked: roster.filter((r) => r.state === 'worked' || r.state === 'on-floor').length,
        onFloor: roster.filter((r) => r.state === 'on-floor').length,
        missed: roster.filter((r) => r.state === 'missed').length,
        open: roster.filter((r) => r.state === 'open').length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /client-portal/history?from=YYYY-MM-DD&to=YYYY-MM-DD
 * A range (org days, inclusive, ≤ 92 days): the home page's cards
 * computed for that slice — showed-up rate and grade, fill and hours per
 * day, incidents as counts, checklist evidence, safety, the statements
 * that closed inside it, and the service report for every week it
 * touches. Every number comes from the same queries the live view uses.
 */
clientPortalRouter.get('/client-portal/history', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query);
    const now = new Date();
    const fromKey = parseDayKey(req.query.from, 'from');
    const toKey = parseDayKey(req.query.to, 'to');
    if (toKey < fromKey) throw new HttpError(400, 'invalid_range', '`to` is before `from`');
    const from = utcInstantOfLocalMidnight(fromKey, ORG_TZ);
    const toExclusive = utcInstantOfLocalMidnight(nextKey(toKey, 1), ORG_TZ);
    const spanDays = Math.round((toExclusive.getTime() - from.getTime()) / DAY);
    if (spanDays > 92) throw new HttpError(400, 'range_too_long', 'Pick 92 days or fewer.');

    const shifts = await prisma.shift.findMany({
      where: { ...shiftScope(scope), startsAt: { gte: from, lt: toExclusive } },
      select: { id: true, locationId: true, startsAt: true, endsAt: true, status: true, assignedAssociateId: true },
      take: 20000,
    });
    const shiftIds = shifts.map((s) => s.id);
    const dayKeys = new Set<string>();
    for (let k = fromKey; k <= toKey; k = nextKey(k, 1)) dayKeys.add(k);

    const [events, { punched, entries: rangeEntries }, worked, claims, ops, incidents, openIncidents, statements] =
      await Promise.all([
        prisma.attendanceEvent.findMany({
          where: { ...attendanceWhere(scope, from, shiftIds), occurredOn: { gte: from, lt: toExclusive } },
          select: { kind: true, shiftId: true },
          take: 5000,
        }),
        loadPunches(scope, from, toExclusive, now),
        prisma.timeEntry.findMany({
          where: {
            ...entryScope(scope),
            status: { in: ['COMPLETED', 'APPROVED'] },
            clockInAt: { gte: from, lt: toExclusive },
          },
          select: {
            clockInAt: true,
            clockOutAt: true,
            breaks: { select: { startedAt: true, endedAt: true } },
          },
          take: 20000,
        }),
        prisma.openShiftClaim.count({
          where: {
            status: 'APPROVED',
            decidedAt: { gte: from, lt: toExclusive },
            shift: { clientId: scope.clientId, ...(scope.locationId ? { locationId: scope.locationId } : {}) },
          },
        }),
        prisma.opsShift.findMany({
          where: { clientId: scope.clientId, dateKey: { in: [...dayKeys] } },
          select: {
            sopDone: true,
            sopTotal: true,
            taskDone: true,
            taskTotal: true,
            tempAlerts: true,
            closedIncomplete: true,
            _count: { select: { tasks: { where: { photos: { some: {} } } } } },
          },
          take: 2000,
        }),
        prisma.oshaIncident.count({
          where: { clientId: scope.clientId, occurredAt: { gte: from, lt: toExclusive } },
        }),
        prisma.oshaIncident.count({
          where: {
            clientId: scope.clientId,
            occurredAt: { gte: from, lt: toExclusive },
            status: { not: 'RESOLVED' },
          },
        }),
        prisma.clientStatement.findMany({
          where: { clientId: scope.clientId, status: 'FINAL', periodEnd: { gte: from, lt: toExclusive } },
          orderBy: { periodEnd: 'desc' },
          take: 20,
          select: {
            id: true,
            number: true,
            periodStart: true,
            periodEnd: true,
            paidAt: true,
            snapshot: true,
          },
        }),
      ]);

    const ncnsIds = new Set(events.filter((e) => e.kind === 'NO_CALL_NO_SHOW' && e.shiftId).map((e) => e.shiftId));
    const targetLocations = await loadTargets(scope, now);
    const rangeHours = coverageByHours({
      locations: targetLocations,
      storeScoped: !!scope.locationId,
      from,
      to: toExclusive,
      now,
      shifts,
      entries: rangeEntries,
    });
    const reviewed = await loadAcknowledgements(scope.clientId);
    // Market accounts: the stores side by side, ranked by the same grade.
    let storeRows: Array<{
      id: string;
      name: string;
      published: number;
      filled: number;
      ended: number;
      showed: number;
      fillPct: number | null;
      reliabilityPct: number | null;
      grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    }> = [];
    if (!scope.locationId) {
      const locations = await prisma.location.findMany({
        where: { clientId: scope.clientId, deletedAt: null, isActive: true },
        select: { id: true, name: true },
        take: 200,
      });
      if (locations.length > 1) {
        const shiftLoc = await prisma.shift.findMany({
          where: { id: { in: shiftIds } },
          select: { id: true, locationId: true },
          take: 20000,
        });
        const locOf = new Map(shiftLoc.map((s) => [s.id, s.locationId]));
        storeRows = locations
          .map((l) => {
            const mine = shifts.filter((s) => locOf.get(s.id) === l.id);
            const published = mine.length;
            const filled = mine.filter((s) => s.status !== 'OPEN').length;
            const endedRows = mine.filter((s) => s.endsAt.getTime() <= now.getTime());
            const showed = endedRows.filter(
              (s) => s.status !== 'OPEN' && !ncnsIds.has(s.id) && punched(s),
            ).length;
            const mineHours = coverageByHours({
              locations: targetLocations.filter((t) => t.id === l.id),
              storeScoped: true,
              from,
              to: toExclusive,
              now,
              shifts: mine,
              entries: rangeEntries.filter((e) => e.locationId === l.id),
            });
            const g = gradeWeeks([
              {
                contracted: mineHours.reduce((a, h) => a + h.target, 0),
                delivered: mineHours.reduce((a, h) => a + h.delivered, 0),
                ended: endedRows.length,
                showed,
              },
            ]);
            return {
              id: l.id,
              name: l.name,
              published,
              filled,
              ended: endedRows.length,
              showed,
              fillPct: published > 0 ? Math.round((filled / published) * 100) : null,
              reliabilityPct: g.score,
              grade: g.grade,
            };
          })
          .sort((a, b) => (b.reliabilityPct ?? -1) - (a.reliabilityPct ?? -1) || a.name.localeCompare(b.name));
      }
    }
    const days = new Map(
      [...dayKeys].map((k) => [
        k,
        {
          date: k,
          published: 0,
          filled: 0,
          ended: 0,
          showed: 0,
          open: 0,
          scheduledHours: 0,
          contracted: 0,
          delivered: 0,
        },
      ]),
    );
    for (const s of shifts) {
      const d = days.get(orgDateKey(s.startsAt));
      if (!d) continue;
      d.published += 1;
      if (s.status === 'OPEN') d.open += 1;
      else d.filled += 1;
      d.scheduledHours += paidMinutesForRange(s.startsAt, s.endsAt) / 60;
      if (s.endsAt.getTime() <= now.getTime()) {
        d.ended += 1;
        if (s.status !== 'OPEN' && !ncnsIds.has(s.id) && punched(s)) d.showed += 1;
      }
    }
    for (const h of rangeHours) {
      const d = days.get(orgDateKey(h.instant));
      if (!d) continue;
      d.contracted += h.target;
      d.delivered += h.delivered;
    }
    const workedByDay = new Map<string, number>();
    for (const e of worked) {
      const k = orgDateKey(e.clockInAt);
      workedByDay.set(k, (workedByDay.get(k) ?? 0) + netMinutes(e, now) / 60);
    }
    const dayRows = [...days.values()].map((d) => ({
      ...d,
      scheduledHours: Math.round(d.scheduledHours * 10) / 10,
      workedHours: Math.round((workedByDay.get(d.date) ?? 0) * 10) / 10,
      fillPct: d.published > 0 ? Math.round((d.filled / d.published) * 100) : null,
      reliabilityPct:
        d.contracted > 0
          ? Math.round((d.delivered / d.contracted) * 100)
          : d.ended > 0
            ? Math.round((d.showed / d.ended) * 100)
            : null,
      showedUpPct: d.ended > 0 ? Math.round((d.showed / d.ended) * 100) : null,
    }));
    const sum = (f: (d: (typeof dayRows)[number]) => number) => dayRows.reduce((a, d) => a + f(d), 0);
    const published = sum((d) => d.published);
    const filled = sum((d) => d.filled);
    const graded = gradeWeeks(dayRows);
    const count = (kind: string) => events.filter((e) => e.kind === kind).length;
    const opsSum = (f: (o: (typeof ops)[number]) => number) => ops.reduce((a, o) => a + f(o), 0);

    // One service report per org week the range touches.
    const weekStarts: string[] = [];
    for (let k = orgDateKey(startOfWeekUTC(from)); k <= toKey; k = nextKey(k, 7)) weekStarts.push(k);
    const preview = req.user!.role !== 'CLIENT_PORTAL';
    const previewQs = preview
      ? `&clientId=${encodeURIComponent(scope.clientId)}${scope.locationId ? `&locationId=${encodeURIComponent(scope.locationId)}` : ''}`
      : scope.locationId && !req.user!.locationId
        ? `&locationId=${encodeURIComponent(scope.locationId)}`
        : '';

    res.json({
      client: { id: scope.client.id, name: scope.client.name },
      store: scope.location ? { id: scope.location.id, name: scope.location.name } : null,
      range: { from: fromKey, to: toKey, days: spanDays },
      generatedAt: now.toISOString(),
      days: dayRows,
      totals: {
        published,
        filled,
        open: published - filled,
        ended: sum((d) => d.ended),
        showed: sum((d) => d.showed),
        fillPct: published > 0 ? Math.round((filled / published) * 100) : null,
        reliabilityPct: graded.score,
        grade: graded.grade,
        basis: graded.basis,
        contractedHours: sum((d) => d.contracted),
        deliveredHours: sum((d) => d.delivered),
        showedUpPct:
          sum((d) => d.ended) > 0
            ? Math.round((sum((d) => d.showed) / sum((d) => d.ended)) * 100)
            : null,
        scheduledHours: Math.round(sum((d) => d.scheduledHours) * 10) / 10,
        workedHours: Math.round(sum((d) => d.workedHours) * 10) / 10,
      },
      incidents: {
        noCallNoShows: count('NO_CALL_NO_SHOW'),
        callOuts: count('CALL_OUT'),
        lates: count('LATE'),
        replacementsFound: claims,
      },
      ops:
        ops.length > 0
          ? {
              shifts: ops.length,
              sopDone: opsSum((o) => o.sopDone),
              sopTotal: opsSum((o) => o.sopTotal),
              taskDone: opsSum((o) => o.taskDone),
              taskTotal: opsSum((o) => o.taskTotal),
              tempAlerts: opsSum((o) => o.tempAlerts),
              incomplete: ops.filter((o) => o.closedIncomplete).length,
              photos: opsSum((o) => o._count.tasks),
            }
          : null,
      safety: { incidents, open: openIncidents },
      statements: statements.map((st) => {
        const snap = st.snapshot as {
          totals?: { amount?: number; hours?: number };
          stores?: Array<{ locationName: string; hours: number; amount: number }>;
        } | null;
        const storeLine = scope.location
          ? (snap?.stores ?? []).find((s) => s.locationName === scope.location!.name) ?? null
          : null;
        return {
          id: st.id,
          number: st.number,
          periodStart: st.periodStart.toISOString().slice(0, 10),
          periodEnd: st.periodEnd.toISOString().slice(0, 10),
          amount: snap?.totals?.amount ?? null,
          hours: snap?.totals?.hours ?? null,
          storeHours: storeLine ? storeLine.hours : null,
          storeAmount: storeLine ? storeLine.amount : null,
          paidAt: st.paidAt ? st.paidAt.toISOString() : null,
          pdfUrl: `/api/client-portal/statements/${st.id}.pdf${previewQs ? `?${previewQs.slice(1)}` : ''}`,
          reviewed: reviewed('STATEMENT', st.id),
        };
      }),
      serviceReports: weekStarts.map((w) => ({
        weekStart: w,
        weekEnd: nextKey(w, 6),
        url: `/api/client-portal/service-report.pdf?week=${w}${previewQs}`,
        reviewed: reviewed('SERVICE_REPORT', w),
      })),
      stores: storeRows,
    });
  } catch (err) {
    next(err);
  }
});

/* ====================================================================== */
/* The loop: people on the roster, and the client's "reviewed" mark.       */
/* ====================================================================== */

/**
 * GET /client-portal/people — the store's own roster (anyone with a
 * published shift in the last 14 days or the next 14 at this scope), so a
 * request can name the person it's about without free text. Names only.
 */
clientPortalRouter.get('/client-portal/people', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query);
    const now = new Date();
    const rows = await prisma.shift.findMany({
      where: {
        ...shiftScope(scope),
        assignedAssociateId: { not: null },
        startsAt: { gte: new Date(now.getTime() - 14 * DAY), lt: new Date(now.getTime() + 14 * DAY) },
      },
      select: {
        position: true,
        startsAt: true,
        assignedAssociate: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { startsAt: 'desc' },
      take: 3000,
    });
    const people = new Map<string, { id: string; name: string; position: string }>();
    for (const r of rows) {
      const a = r.assignedAssociate;
      if (!a || people.has(a.id)) continue;
      people.set(a.id, { id: a.id, name: fullName(a), position: r.position });
    }
    res.json({
      people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err) {
    next(err);
  }
});

const AcknowledgeSchema = z.object({
  kind: z.enum(['STATEMENT', 'SERVICE_REPORT']),
  /** STATEMENT → statement id; SERVICE_REPORT → org week start (YYYY-MM-DD). */
  key: z.string().min(1).max(64),
});

/**
 * POST /client-portal/acknowledge — "reviewed", timestamped and
 * attributed, one per document per client. Idempotent: a second mark
 * returns the first. Portal accounts only (a preview can't sign for the
 * client).
 */
clientPortalRouter.post('/client-portal/acknowledge', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'CLIENT_PORTAL' || !req.user!.clientId) {
      throw new HttpError(403, 'forbidden', 'Only a client account can mark a document reviewed.');
    }
    const clientId = req.user!.clientId;
    const input = AcknowledgeSchema.parse(req.body);
    if (input.kind === 'STATEMENT') {
      const st = await prisma.clientStatement.findFirst({
        where: { id: input.key, clientId, status: 'FINAL' },
        select: { id: true },
      });
      if (!st) throw new HttpError(404, 'not_found', 'Statement not found');
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(input.key)) {
      throw new HttpError(400, 'invalid_key', 'A service report is keyed by its week start (YYYY-MM-DD).');
    }
    const existing = await prisma.clientAcknowledgement.findUnique({
      where: { clientId_kind_subjectKey: { clientId, kind: input.kind, subjectKey: input.key } },
      include: { user: { select: { associate: { select: { firstName: true } }, email: true } } },
    });
    const row =
      existing ??
      (await prisma.clientAcknowledgement.create({
        data: { clientId, kind: input.kind, subjectKey: input.key, userId: req.user!.id },
        include: { user: { select: { associate: { select: { firstName: true } }, email: true } } },
      }));
    res.status(existing ? 200 : 201).json({
      kind: row.kind,
      key: row.subjectKey,
      reviewedAt: row.createdAt.toISOString(),
      reviewedBy: reviewerName(row.user),
    });
  } catch (err) {
    next(err);
  }
});
