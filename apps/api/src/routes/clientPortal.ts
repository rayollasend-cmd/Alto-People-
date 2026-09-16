import { Router } from 'express';
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

/**
 * The contracted headcount for "right now": per location, the newest
 * effective-dated window whose site-local wall-clock span contains now
 * (windows wrap past midnight when end <= start); when no window
 * matches, the location's TOTAL target (null label). Summed across the
 * scope's locations.
 */
async function currentTarget(
  scope: PortalScope,
  now: Date,
): Promise<{ target: number | null; label: string | null }> {
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
  if (locations.length === 0) return { target: null, label: null };
  const rows = await prisma.staffingTarget.findMany({
    where: {
      locationId: { in: locations.map((l) => l.id) },
      effectiveFrom: { lte: now },
    },
    orderBy: { effectiveFrom: 'desc' },
    select: {
      locationId: true,
      targetCount: true,
      label: true,
      startMinute: true,
      endMinute: true,
    },
    take: 2000,
  });
  if (rows.length === 0) return { target: null, label: null };
  // Newest-first: first hit per (location, label) wins.
  const seen = new Set<string>();
  const totals = new Map<string, number>();
  const windows = new Map<
    string,
    Array<{ label: string; start: number; end: number; count: number }>
  >();
  for (const r of rows) {
    const key = `${r.locationId}|${r.label ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.label === null) {
      totals.set(r.locationId, r.targetCount);
    } else if (r.startMinute !== null && r.endMinute !== null) {
      const list = windows.get(r.locationId) ?? [];
      list.push({ label: r.label, start: r.startMinute, end: r.endMinute, count: r.targetCount });
      windows.set(r.locationId, list);
    }
  }
  let target = 0;
  let any = false;
  const labels = new Set<string>();
  for (const loc of locations) {
    const minute = zonedMinutes(now, loc.timezone);
    const matching = (windows.get(loc.id) ?? []).filter((w) =>
      w.end > w.start ? minute >= w.start && minute < w.end : minute >= w.start || minute < w.end,
    );
    if (matching.length > 0) {
      for (const w of matching) {
        target += w.count;
        labels.add(w.label);
      }
      any = true;
    } else if (totals.has(loc.id)) {
      target += totals.get(loc.id)!;
      any = true;
    }
  }
  if (!any) return { target: null, label: null };
  return { target, label: labels.size === 1 ? [...labels][0]! : null };
}

/** Letter grade for a run of weeks. Per week: fill % minus 3 points per
 *  no-call no-show, 1 per call-out, ½ per late arrival (floored at 0);
 *  averaged over weeks that had shifts. A ≥ 95, B ≥ 88, C ≥ 80, D ≥ 70. */
function gradeWeeks(
  weeks: Array<{
    total: number;
    fillPct: number | null;
    noCallNoShows: number;
    callOuts: number;
    lates: number;
  }>,
): { grade: 'A' | 'B' | 'C' | 'D' | 'F' | null; score: number | null } {
  const scored = weeks
    .filter((w) => w.total > 0 && w.fillPct !== null)
    .map((w) =>
      Math.max(0, (w.fillPct ?? 0) - 3 * w.noCallNoShows - w.callOuts - 0.5 * w.lates),
    );
  if (scored.length === 0) return { grade: null, score: null };
  const score = Math.round(scored.reduce((a, b) => a + b, 0) / scored.length);
  const grade = score >= 95 ? 'A' : score >= 88 ? 'B' : score >= 80 ? 'C' : score >= 70 ? 'D' : 'F';
  return { grade, score };
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
        select: { id: true, startsAt: true, endsAt: true, status: true, assignedAssociateId: true },
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

    // Attendance events carry a shiftId but no relation, so the store scope
    // keys them on the store's own shifts (already loaded for the trend).
    const trendEvents = await prisma.attendanceEvent.findMany({
      where: {
        clientId,
        occurredOn: { gte: trendStart },
        excusedAt: null,
        ...(scope.locationId ? { shiftId: { in: trendShifts.map((s) => s.id) } } : {}),
      },
      select: { kind: true, occurredOn: true },
      take: 2000,
    });

    const onFloorIds = new Set(onFloorEntries.map((e) => e.associateId));
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
        { start: k, filled: 0, total: 0, noCallNoShows: 0, callOuts: 0, lates: 0, replaced: 0 },
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
    const weeks = weekKeys.map((k) => {
      const w = weekAgg.get(k)!;
      return {
        ...w,
        end: nextKey(k, 6),
        fillPct: w.total > 0 ? Math.round((w.filled / w.total) * 100) : null,
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
      reliability: { weeks, grade: graded.grade, score: graded.score },
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
