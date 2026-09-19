import { Router } from 'express';
import { z } from 'zod';
import { hasCapability, paidMinutesForRange } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';
import { orgDateKey } from '../lib/timeAnomalies.js';
import { enqueueAudit } from '../lib/audit.js';
import { ensureBrandingLoaded } from '../lib/branding.js';
import { renderStatementPdf } from '../lib/statementPdf.js';
import { REPORT_MAX_DAYS, buildPortalReport, renderPortalReportPdf } from '../lib/portalDayReport.js';
import { notePortalReportDownload } from '../lib/portalEngagement.js';
import { trackNotificationWork } from '../lib/notify.js';
import { currentStoreWindows, ledWindows } from '../lib/shiftWindows.js';
import type { StatementSnapshot } from '../lib/clientStatement.js';
import {
  DAY,
  ORG_TZ,
  attendanceWhere,
  coverageByHours,
  currentTarget,
  entryScope,
  fullName,
  gradeWeeks,
  loadAcknowledgements,
  loadPunches,
  loadTargets,
  netMinutes,
  nextKey,
  portalCalendar,
  reviewerName,
  shiftScope,
  type PortalScope,
} from '../lib/portalMetrics.js';

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



/**
 * Resolve who the caller is looking at. Fails closed for a portal
 * account without a client; 404s when the preview target doesn't exist
 * or the store isn't under the client.
 *
 * `floorLead`: the route also serves the store's supervisors — SHIFT_ and
 * FLOOR_SUPERVISOR — their own client, opt-in per route, so only payloads
 * with nothing the roles can't already see (the day roster: names,
 * positions, punches — never money) take it. The home overview and history carry statements and the client's
 * service record, and never opt in.
 */
async function resolveScope(
  user: SessionUser,
  query: { clientId?: unknown; locationId?: unknown },
  opts: { floorLead?: boolean } = {},
): Promise<PortalScope> {
  let clientId: string;
  let locationId: string | null = null;
  if (user.role === 'CLIENT_PORTAL' && !user.clientId && user.regionId) {
    // A REGION account (the command center) opens any store in its region
    // by naming it — validated below to belong to the region, never wider.
    const loc =
      typeof query.locationId === 'string' && query.locationId
        ? await prisma.location.findFirst({
            where: { id: query.locationId, regionId: user.regionId, deletedAt: null },
            select: { id: true, clientId: true },
          })
        : null;
    if (!loc) throw new HttpError(400, 'store_required', 'Pick a store in your region.');
    clientId = loc.clientId;
    locationId = loc.id;
  } else if (user.role === 'CLIENT_PORTAL') {
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
  } else if (opts.floorLead && (user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR')) {
    // Clamped to their own client; ?clientId= is ignored. A store inside
    // it may be named (validated below to belong to the same client).
    if (!user.clientId) {
      throw new HttpError(403, 'no_client_assigned', 'Your account is not assigned to a client.');
    }
    clientId = user.clientId;
    locationId =
      typeof query.locationId === 'string' && query.locationId ? query.locationId : null;
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

type RosterState = 'open' | 'on-floor' | 'done' | 'confirmed' | 'unconfirmed';

/** Every shift window at the scope's store(s) with the supervisors who lead
 *  it (empty = nobody yet). */
async function dayWindowLeads(scope: PortalScope) {
  const stores = scope.locationId
    ? [{ id: scope.locationId }]
    : await prisma.location.findMany({
        where: { clientId: scope.clientId, deletedAt: null },
        select: { id: true },
      });
  const [defs, led] = await Promise.all([
    currentStoreWindows(prisma, stores.map((s) => s.id)),
    ledWindows(prisma, { clientId: scope.clientId }),
  ]);
  return [...defs.values()].map((w) => ({
    locationId: w.locationId,
    label: w.label,
    startMinute: w.startMinute,
    endMinute: w.endMinute,
    leads: led
      .filter((l) => l.locationId === w.locationId && l.label === w.label)
      .map((l) => l.userName),
  }));
}

clientPortalRouter.get('/client-portal/overview', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query);
    const { clientId } = scope;

    // Days and weeks on the store's own clock (lib/portalMetrics).
    const cal = await portalCalendar(scope);
    const now = new Date();
    const todayKey = cal.key(now);
    const todayStart = cal.midnight(todayKey);
    const tomorrowStart = cal.midnight(nextKey(todayKey, 1));
    const dayAfterStart = cal.midnight(nextKey(todayKey, 2));
    const weekStart = cal.weekStart(now);
    const weekEnd = cal.weekEnd(now);
    const thisWeekKey = cal.key(weekStart);
    // Reliability window: the 4 completed weeks before this one, plus
    // this one (rendered separately as "so far").
    const trendStart = cal.midnight(nextKey(thisWeekKey, -4 * 7));
    const monthStart = cal.midnight(`${todayKey.slice(0, 7)}-01`);
    // Store Ops keys its shifts by the org day it opened on.
    const opsTodayKey = orgDateKey(now);
    const opsYesterdayKey = nextKey(opsTodayKey, -1);

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
        where: { clientId, dateKey: { in: [opsYesterdayKey, opsTodayKey] } },
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

    // ---- Week shape + reliability trend (store weeks, Sat→Fri) --------
    const weekKeyOf = (d: Date) => cal.key(cal.weekStart(d));
    const weekKeys: string[] = [];
    for (let i = 4; i >= 0; i--) weekKeys.push(nextKey(thisWeekKey, -7 * i));
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
        const bucket = dayMap.get(cal.key(s.startsAt));
        if (bucket) {
          if (s.status === 'OPEN') bucket.open += 1;
          else bucket.filled += 1;
        }
        weekMinutes += paidMinutesForRange(s.startsAt, s.endsAt);
        if (s.assignedAssociateId) weekAssociateIds.add(s.assignedAssociateId);
      }
    }
    // occurredOn is a calendar DATE (UTC midnight on the wire): the day it
    // names, not an instant read on the store's clock — through the zone, a
    // Saturday's no-show landed in the week before.
    const dayWeekKey = (d: Date) =>
      weekKeyOf(new Date(cal.midnight(d.toISOString().slice(0, 10)).getTime() + DAY / 2));
    for (const e of trendEvents) {
      const wk = weekAgg.get(dayWeekKey(e.occurredOn));
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
      opsShifts.filter((o) => o.dateKey === opsTodayKey && o.status === 'ACTIVE').map((o) => o.openedById),
    );
    // Supervisors lead named shift windows ("Overnight"). A store account
    // sees the leads of ITS store's windows (plus anyone not yet given a
    // shift, as before); each lead carries the shifts they hold there.
    const led = await ledWindows(prisma, { clientId: scope.clientId });
    const ledHere = led.filter((w) => !scope.locationId || w.locationId === scope.locationId);
    const withShifts = new Set(led.map((w) => w.userId));
    const leads = leadUsers
      .filter((u) => !withShifts.has(u.id) || ledHere.some((w) => w.userId === u.id))
      .map((u) => ({
        userId: u.id,
        name: u.associate ? fullName(u.associate) : u.email.split('@')[0] ?? u.email,
        phone: u.associate?.phone ?? null,
        email: u.email,
        title: u.role === 'SHIFT_SUPERVISOR' ? ('supervisor' as const) : ('floor-lead' as const),
        onFloor: !!u.associateId && onFloorIds.has(u.associateId),
        runningOps: opsRunners.has(u.id),
        shifts: [...new Set(ledHere.filter((w) => w.userId === u.id).map((w) => w.label))],
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
    const lastCompletedWeek = nextKey(thisWeekKey, -7);
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
          ? { yesterday: opsDay(opsYesterdayKey), today: opsDay(opsTodayKey) }
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
    const cal = await portalCalendar(scope);
    // A ?week= day is a calendar date: its store-local noon is on that day.
    const anchor = weekParam ? cal.midnight(weekParam) : new Date();
    const weekStart = cal.weekStart(anchor);
    const weekEnd = cal.weekEnd(anchor);
    const now = new Date();
    const startKey = cal.key(weekStart);

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
      const list = days.get(cal.key(s.startsAt));
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
 * GET /client-portal/service-report.pdf
 *   ?date=YYYY-MM-DD            one day (default: today — the live page, frozen)
 *   ?from=YYYY-MM-DD&to=…       a range of org days, ≤ 31
 *   ?week=YYYY-MM-DD            the org week (Sat→Fri) containing that date
 * The portal on paper: the same instruments as the live page, for the
 * day the manager picks, so the 16th's report is what the portal showed
 * on the 16th. Clamped to the caller's scope (store or client).
 */
clientPortalRouter.get(
  '/client-portal/service-report.pdf',
  requireAuth,
  async (req, res, next) => {
    try {
      const scope = await resolveScope(req.user!, req.query);
      const cal = await portalCalendar(scope);
      const now = new Date();
      let fromKey: string;
      let toKey: string;
      if (req.query.week !== undefined) {
        const weekParam = parseDayKey(req.query.week, 'week');
        fromKey = cal.key(cal.weekStart(cal.midnight(weekParam)));
        toKey = nextKey(fromKey, 6);
      } else if (req.query.from !== undefined || req.query.to !== undefined) {
        fromKey = parseDayKey(req.query.from, 'from');
        toKey = parseDayKey(req.query.to, 'to');
        if (toKey < fromKey) throw new HttpError(400, 'invalid_range', '`to` is before `from`');
        const span = Math.round(
          (cal.midnight(nextKey(toKey, 1)).getTime() - cal.midnight(fromKey).getTime()) / DAY,
        );
        if (span > REPORT_MAX_DAYS) throw new HttpError(400, 'range_too_long', `Pick ${REPORT_MAX_DAYS} days or fewer.`);
      } else {
        fromKey = req.query.date === undefined ? cal.key(now) : parseDayKey(req.query.date, 'date');
        toKey = fromKey;
      }
      const branding = await ensureBrandingLoaded(prisma);
      const data = await buildPortalReport(scope, fromKey, toKey, branding.orgName, now, cal);
      const pdf = await renderPortalReportPdf(data);
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          clientId: scope.clientId,
          action: 'client.service_report_exported',
          entityType: 'Client',
          entityId: scope.clientId,
          metadata: { from: fromKey, to: toKey, locationId: scope.locationId, via: 'portal' },
        },
        'clients.service_report',
      );
      // A store or market manager pulling a report is a signal for the
      // account team (bell to HR + the Operations Manager). Admin previews stay silent.
      if (req.user!.role === 'CLIENT_PORTAL') {
        void trackNotificationWork(notePortalReportDownload({ userId: req.user!.id, fromKey, toKey, now }));
      }
      const slug = (scope.location?.name ?? scope.client.name).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="service-report-${slug}-${fromKey === toKey ? fromKey : `${fromKey}-to-${toKey}`}.pdf"`,
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
    // The supervisor's Today page is this page — same grammar, own client.
    const scope = await resolveScope(req.user!, req.query, { floorLead: true });
    const now = new Date();
    // The day is the store's calendar day, cut at the store's midnight.
    const cal = await portalCalendar(scope);
    const storeToday = cal.key(now);
    const dateKey = req.query.date === undefined ? storeToday : parseDayKey(req.query.date, 'date');
    const dayStart = cal.midnight(dateKey);
    const dayEnd = cal.midnight(nextKey(dateKey, 1));

    // "Now" belongs to the page the viewer calls today, and that's the
    // BROWSER's calendar, which can sit a day off the store's (a viewer in
    // New York at 1 AM looking at a Pacific store). Any date within a day of
    // the store's today carries the live list; the page shows it only for
    // its own today.
    const isToday =
      dateKey === storeToday || dateKey === nextKey(storeToday, -1) || dateKey === nextKey(storeToday, 1);
    const [rows, leadPositions, { punchFor }, target, liveEntries] = await Promise.all([
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
          locationId: true,
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
      // Who is on the floor RIGHT NOW is every open clock-in — the live
      // board's (and the home hero's) definition, not just punches matched
      // to an assigned shift. A walk-in, someone covering a shift assigned
      // to another name, a shift still in draft, or a person staying past
      // their end is on the floor all the same; the roster alone read 0.
      isToday
        ? prisma.timeEntry.findMany({
            where: { ...entryScope(scope), status: 'ACTIVE' },
            select: {
              associateId: true,
              clockInAt: true,
              associate: { select: { firstName: true, lastName: true } },
              shift: { select: { position: true } },
            },
            orderBy: { clockInAt: 'asc' },
            take: 300,
          })
        : Promise.resolve([]),
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
        locationId: s.locationId,
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
      today: storeToday,
      generatedAt: now.toISOString(),
      target: target.target,
      roster,
      // Who leads each of the store's shift windows — the wave header
      // names its lead ("Lead · Dana Reyes").
      windowLeads: await dayWindowLeads(scope),
      onFloorNow: liveEntries.map((e) => ({
        associateId: e.associateId,
        name: fullName(e.associate),
        clockInAt: e.clockInAt.toISOString(),
        position: e.shift?.position ?? null,
      })),
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
    const cal = await portalCalendar(scope);
    const now = new Date();
    const fromKey = parseDayKey(req.query.from, 'from');
    const toKey = parseDayKey(req.query.to, 'to');
    if (toKey < fromKey) throw new HttpError(400, 'invalid_range', '`to` is before `from`');
    const from = cal.midnight(fromKey);
    const toExclusive = cal.midnight(nextKey(toKey, 1));
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
      const d = days.get(cal.key(s.startsAt));
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
      const d = days.get(cal.key(h.instant));
      if (!d) continue;
      d.contracted += h.target;
      d.delivered += h.delivered;
    }
    const workedByDay = new Map<string, number>();
    for (const e of worked) {
      const k = cal.key(e.clockInAt);
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

    // One service report per store week the range touches.
    const weekStarts: string[] = [];
    for (let k = cal.key(cal.weekStart(from)); k <= toKey; k = nextKey(k, 7)) weekStarts.push(k);
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
