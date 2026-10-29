import { requireModule } from '../lib/tenantProfile.js';
import { Router } from 'express';
import { regionSiteIds, regionUnitPath } from '../lib/orgUnits.js';
import type { OpsPeriod, Prisma } from '@prisma/client';
import { z } from 'zod';
import { paidMinutesForRange, can, toDateOnly } from '@alto-people/shared';
import { prisma } from '../db.js';
import { accountPhotoUrlFor, profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';
import { orgDateKey } from '../lib/timeAnomalies.js';
import { enqueueAudit } from '../lib/audit.js';
import { ensureBrandingLoaded } from '../lib/branding.js';
import { renderStatementPdf, statementContext } from '../lib/statementPdf.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { REPORT_MAX_DAYS, buildPortalReport, renderPortalReportPdf } from '../lib/portalDayReport.js';
import { notePortalReportDownload } from '../lib/portalEngagement.js';
import { notifyUser, trackNotificationWork } from '../lib/notify.js';
import { auditRecruiting, recordCandidateEvent } from '../lib/candidateEvents.js';
import { currentStoreWindows, ledWindows } from '../lib/shiftWindows.js';
import type { StatementSnapshot } from '../lib/clientStatement.js';
import { buildStoreOps, opsShiftScope, runExpired, scopedOpsPhoto } from '../lib/portalOps.js';
import { getBlobStore } from '../lib/blobStore.js';
import {
  SIGNOFF_LOOKBACK_WEEKS,
  lastFinishedWeek,
  signOffState,
  signOffView,
  signableWeek,
  storeWeekHours,
  storeWeekKey,
  weekDate,
  type SignOffFlag,
} from '../lib/portalHoursSignOff.js';
import { DOWNLOAD_ROLES, ENGAGEMENT_CATEGORY, notifyRoles } from '../lib/portalEngagement.js';
import { fmtDayRange } from '../lib/humanDates.js';
import { daysPastDue, unpaidStatementsWhere, waitingCandidatesWhere } from '../lib/portalNeedsYou.js';
import {
  DAY,
  ORG_TZ,
  attendanceWhere,
  coverageByHours,
  currentTarget,
  entryScope,
  fullName,
  gradeWeeks,
  incidentWhere,
  loadAcknowledgements,
  serviceReportKey,
  loadPunches,
  loadTargets,
  netMinutes,
  nextKey,
  portalCalendar,
  readAll,
  reviewerName,
  shiftScope,
  storeCalendar,
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
// Tenant profile (Brief 2-1b): the portal exists only where the client portal module is on — 404 on every path, not 403.
clientPortalRouter.use('/client-portal', requireModule('clientPortal'));



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
  let locationId: string | null;
  if (user.role === 'CLIENT_PORTAL' && !user.clientId && user.regionId) {
    // A REGION account (the command center) opens any store in its region
    // by naming it — validated below to belong to the region, never wider.
    const loc =
      typeof query.locationId === 'string' && query.locationId
        ? await prisma.site.findFirst({
            where: { AND: [{ id: query.locationId }, { id: { in: await regionSiteIds(prisma, user.regionId) } }], deletedAt: null },
            select: { id: true, clientId: true },
          })
        : null;
    if (!loc) throw new HttpError(400, 'store_required', 'Pick a store in your region.');
    // The portal is a client's; a client-less store (a direct employer) has no portal.
    if (!loc.clientId) throw new HttpError(400, 'client_required', 'This store has no client.');
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
    // A supervisor pinned to a store stays there, exactly like a store
    // portal account: their own store wins and the query param is
    // ignored. Only a floating supervisor (no store of their own) may
    // name one. Before this, a store-bound supervisor who opened the day
    // or ops view without a param got the whole client.
    locationId =
      user.locationId ??
      (typeof query.locationId === 'string' && query.locationId ? query.locationId : null);
  } else if (
    can(user, 'view:executive') ||
    can(user, 'manage:org')
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
    location = await prisma.site.findFirst({
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

/**
 * A client with ONE store: that store's share of a statement IS the
 * statement (F500 G5). A store account at a multi-store client still sees
 * only its own line — the client-wide total is every other store's labour
 * spend too — but at a one-store client there is nothing else on it.
 */
async function singleStoreClient(clientId: string): Promise<boolean> {
  return (await prisma.site.count({ where: { clientId, deletedAt: null } })) === 1;
}

type StatementSnap = {
  totals?: { amount?: number; hours?: number };
  stores?: Array<{ locationName: string; hours: number; amount: number }>;
} | null;

/**
 * One statement as the portal shows it — the home and History read the
 * same row. A store account at a multi-store client gets its own store's
 * line and no PDF; at a one-store client the totals and the PDF are its
 * own. `daysPastDue` counts on the store's calendar, from the due date.
 */
function portalStatementRow(
  st: { id: string; number: number | null; periodStart: Date; periodEnd: Date; finalizedAt: Date | null; paidAt: Date | null; dueAt: Date | null; poNumber: string | null; snapshot: unknown },
  opts: { scope: PortalScope; singleStore: boolean; todayKey: string; pdfUrl: (id: string) => string },
) {
  const snap = st.snapshot as StatementSnap;
  const { scope } = opts;
  const storeScoped = scope.locationId !== null;
  // The store's whole statement when it is the client's only store.
  const ownsTotals = !storeScoped || opts.singleStore;
  const storeLine = scope.location
    ? (snap?.stores ?? []).find((s) => s.locationName === scope.location!.name) ?? null
    : null;
  const dueKey = toDateOnly(st.dueAt);
  const pastDue = st.paidAt ? null : daysPastDue(st.dueAt, opts.todayKey);
  return {
    id: st.id,
    number: st.number,
    periodStart: toDateOnly(st.periodStart)!,
    periodEnd: toDateOnly(st.periodEnd)!,
    amount: ownsTotals ? (snap?.totals?.amount ?? null) : null,
    hours: ownsTotals ? (snap?.totals?.hours ?? null) : null,
    storeHours: storeLine ? storeLine.hours : storeScoped && opts.singleStore ? (snap?.totals?.hours ?? null) : null,
    storeAmount: storeLine ? storeLine.amount : storeScoped && opts.singleStore ? (snap?.totals?.amount ?? null) : null,
    finalizedAt: st.finalizedAt ? st.finalizedAt.toISOString() : null,
    paidAt: st.paidAt ? st.paidAt.toISOString() : null,
    /** The day it falls due (YYYY-MM-DD), the PO it bills against. */
    dueAt: dueKey,
    poNumber: st.poNumber,
    /** Days past the due date, unpaid; null when paid, not yet due or no due date. */
    daysPastDue: pastDue,
    pdfUrl: ownsTotals ? opts.pdfUrl(st.id) : null,
  };
}

type RosterState = 'open' | 'on-floor' | 'done' | 'confirmed' | 'unconfirmed';

/** Every shift window at the scope's store(s) with the supervisors who lead
 *  it (empty = nobody yet). */
async function dayWindowLeads(scope: PortalScope) {
  const stores = scope.locationId
    ? [{ id: scope.locationId }]
    : await prisma.site.findMany({
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
    // The contracted headcount for the window, so a day with nothing
    // scheduled can say what it is short of (F500 G5).
    targetCount: w.targetCount,
    leads: led
      .filter((l) => l.locationId === w.locationId && l.label === w.label)
      .map((l) => l.userName),
  }));
}

/** The day's contracted headcount: every window's count summed (a store with only a total, the total). */
function dailyContract(locations: Awaited<ReturnType<typeof loadTargets>>): number | null {
  let any = false;
  let n = 0;
  for (const l of locations) {
    if (l.windows.length > 0) {
      any = true;
      n += l.windows.reduce((a, w) => a + w.count, 0);
    } else if (l.total !== null) {
      any = true;
      n += l.total;
    }
  }
  return any ? n : null;
}

/** Contracted person-hours over a Sat→Fri week: each window's headcount × its length × 7. */
function weeklyContractHours(locations: Awaited<ReturnType<typeof loadTargets>>): number | null {
  let any = false;
  let minutes = 0;
  for (const l of locations) {
    for (const w of l.windows) {
      any = true;
      const len = (w.end - w.start + 1440) % 1440 || 1440;
      minutes += w.count * len * 7;
    }
  }
  return any ? Math.round(minutes / 60) : null;
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
    // Store Ops files a store window's run under the STORE day its window
    // opened on (lib/portalOps runDayKey) — the store's today, not the
    // company's: at 11:30 PM Pacific a Chicago store is already tomorrow.
    const opsTodayKey = todayKey;
    const opsYesterdayKey = nextKey(opsTodayKey, -1);

    const shifts = shiftScope(scope);
    const entries = entryScope(scope);
    const shiftRel = scope.locationId ? { locationId: scope.locationId } : {};
    // Store Ops rows are per store; a store account never sums another
    // building's SOP completion — or reads its closing notes.
    const opsWhere = await opsShiftScope(scope);

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
      // Five weeks of a market's shifts, read whole (no silent cap — CODE-19).
      readAll((page) =>
        prisma.shift.findMany({
          where: { ...shifts, startsAt: { gte: trendStart, lt: weekEnd } },
          select: { id: true, locationId: true, startsAt: true, endsAt: true, status: true, assignedAssociateId: true },
          ...page,
        }),
      ).then((r) => r.rows),
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
          dueAt: true,
          poNumber: true,
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
      readAll((page) =>
        prisma.timeEntry.findMany({
          where: {
            ...entries,
            status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] },
            clockInAt: { gte: weekStart, lt: weekEnd },
          },
          select: {
            id: true,
            clockInAt: true,
            clockOutAt: true,
            breaks: { select: { startedAt: true, endedAt: true } },
          },
          ...page,
        }),
      ).then((r) => r.rows),
      // Alto's leadership at this store: the supervisor accounts bound to
      // the client. Phone rides on the linked associate record.
      prisma.user.findMany({
        where: {
          clientId,
          status: 'ACTIVE',
          deletedAt: null,
          role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] },
          // A store account gets the leadership standing in ITS building:
          // the supervisors pinned to this store, plus any who float
          // across the client (no store of their own). The supervisor
          // corps at the other stores is not this manager's business —
          // and their phone number least of all.
          ...(scope.locationId
            ? { OR: [{ locationId: scope.locationId }, { locationId: null }] }
            : {}),
        },
        select: {
          id: true,
          email: true,
          role: true,
          associateId: true,
          photoS3Key: true,
          photoUpdatedAt: true,
          associate: { select: { id: true, firstName: true, lastName: true, phone: true, photoS3Key: true, photoUpdatedAt: true } },
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
        // Yesterday and today, PLUS anything still running — an overnight
        // crew that clocked on before midnight is filed under yesterday
        // and is standing on the floor right now.
        where: {
          ...opsWhere,
          OR: [
            { dateKey: { in: [opsYesterdayKey, opsTodayKey] } },
            { status: 'ACTIVE' },
          ],
        },
        select: {
          id: true,
          dateKey: true,
          department: true,
          period: true,
          status: true,
          openedById: true,
          openedAt: true,
          closedAt: true,
          closedById: true,
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
        where: { tenantId: tenantIdForWrite() },
        select: { supportEmail: true },
      }),
      prisma.oshaIncident.count({
        where: { ...incidentWhere(scope), occurredAt: { gte: monthStart } },
      }),
      prisma.oshaIncident.count({
        where: { ...incidentWhere(scope), status: { not: 'RESOLVED' } },
      }),
      prisma.oshaIncident.findFirst({
        where: {
          ...incidentWhere(scope),
          occurredAt: { gte: new Date(now.getTime() - 365 * DAY) },
        },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
      currentTarget(scope, now),
      scope.locationId
        ? Promise.resolve([])
        : prisma.site.findMany({
            where: { clientId, deletedAt: null, isActive: true },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
            take: 100,
          }),
    ]);

    // What needs the client (F500 G5 "Needs you"): every unpaid statement
    // (not only the six shown), candidates waiting on their answer, and
    // their requests — Alto's late replies and this week's answers. The
    // request desk is the client account's own (store accounts: their store).
    const requestsWhere =
      req.user!.role === 'CLIENT_PORTAL' && !req.user!.clientId
        ? null
        : { clientId, ...(scope.locationId ? { locationId: scope.locationId } : {}) };
    const [trendEvents, { punched, entries: trendEntries }, targetLocations, tomorrowTargets, unpaid, singleStore, candidatesWaiting, requestRows] = await Promise.all([
      prisma.attendanceEvent.findMany({
        where: attendanceWhere(scope, trendStart, trendShifts.map((s) => s.id)),
        select: { kind: true, occurredOn: true, shiftId: true },
        take: 2000,
      }),
      loadPunches(scope, trendStart, weekEnd, now),
      loadTargets(scope, now),
      loadTargets(scope, tomorrowStart),
      prisma.clientStatement.findMany({
        where: unpaidStatementsWhere(clientId),
        select: { id: true, number: true, periodStart: true, periodEnd: true, finalizedAt: true, paidAt: true, dueAt: true, poNumber: true, snapshot: true },
        orderBy: { dueAt: 'asc' },
        take: 100,
      }),
      singleStoreClient(clientId),
      // The same where-clause as GET /client-portal/candidates' waiting rows (lib/portalNeedsYou).
      prisma.candidateSubmittal.count({ where: waitingCandidatesWhere(scope) }),
      requestsWhere
        ? prisma.clientRequest.findMany({
            where: {
              ...requestsWhere,
              OR: [
                { status: { not: 'RESOLVED' }, dueAt: { lt: now } },
                { status: 'RESOLVED', resolvedAt: { gte: new Date(now.getTime() - 7 * DAY) } },
              ],
            },
            select: { id: true, status: true, dueAt: true, resolvedAt: true },
            orderBy: { createdAt: 'asc' },
            take: 100,
          })
        : Promise.resolve([] as Array<{ id: string; status: string; dueAt: Date | null; resolvedAt: Date | null }>),
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
    // This week's STAFFED shifts, two ways (LEAD-4): gross wall-clock time —
    // the contract's own basis (each window's headcount × its length, meal
    // breaks inside it) — and paid time, breaks out, the basis punches are
    // counted on. Open slots are in neither: an unfilled shift delivers
    // nothing. The tile compared paid-with-open-slots against the gross
    // contract, so a fully staffed store read 502h of 560h in orange.
    let weekMinutes = 0;
    let weekPaidMinutes = 0;
    const weekAssociateIds = new Set<string>();
    for (const s of trendShifts) {
      const wk = weekAgg.get(weekKeyOf(s.startsAt));
      if (wk) {
        wk.total += 1;
        if (s.status !== 'OPEN') wk.filled += 1;
        if (s.endsAt.getTime() <= now.getTime()) {
          wk.ended += 1;
          // Punch evidence wins. A shift someone clocked into counts as
          // showed even if an old no-show event is still on file for it —
          // the person was on the floor, whatever the sweep once inferred.
          if (s.status !== 'OPEN' && punched(s)) wk.showed += 1;
        }
      }
      if (s.startsAt >= weekStart) {
        const bucket = dayMap.get(cal.key(s.startsAt));
        if (bucket) {
          if (s.status === 'OPEN') bucket.open += 1;
          else bucket.filled += 1;
        }
        if (s.status !== 'OPEN') {
          weekMinutes += (s.endsAt.getTime() - s.startsAt.getTime()) / 60_000;
          weekPaidMinutes += paidMinutesForRange(s.startsAt, s.endsAt);
        }
        if (s.assignedAssociateId) weekAssociateIds.add(s.assignedAssociateId);
      }
    }
    // occurredOn is a calendar DATE (UTC midnight on the wire): the day it
    // names, not an instant read on the store's clock — through the zone, a
    // Saturday's no-show landed in the week before.
    const dayWeekKey = (d: Date) =>
      weekKeyOf(new Date(cal.midnight(toDateOnly(d)!).getTime() + DAY / 2));
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
    // `cleared`: per person, I-9 done AND nothing flagged or in flight — the
    // ring's count ("2 of 2 cleared" sat beside "1 I-9 pending", F500 G5).
    let clearance = { total: 0, i9Complete: 0, checksInFlight: 0, flagged: 0, cleared: 0 };
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
      let cleared = 0;
      for (const id of crewIds) {
        if (i9Done.has(id)) i9Complete += 1;
        const statuses = [bgLatest.get(id), dtLatest.get(id)].filter(
          (s): s is string => !!s,
        );
        if (statuses.some((s) => bad.has(s))) flagged += 1;
        else if (statuses.some((s) => inFlight.has(s))) checksInFlight += 1;
        else if (i9Done.has(id)) cleared += 1;
      }
      clearance = { total: crewIds.length, i9Complete, checksInFlight, flagged, cleared };
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
        // null = no photo on file: the page shows initials, no request that 404s (F1 SH-1's rule).
        photoUrl: accountPhotoUrlFor(u),
        title: u.role === 'SHIFT_SUPERVISOR' ? ('supervisor' as const) : ('floor-lead' as const),
        onFloor: !!u.associateId && onFloorIds.has(u.associateId),
        runningOps: opsRunners.has(u.id),
        shifts: [...new Set(ledHere.filter((w) => w.userId === u.id).map((w) => w.label))],
      }));

    // ---- Store ops evidence ---------------------------------------------
    //
    // The store manager's page used to lead with LAST NIGHT and only fall
    // back to today, so at ten in the morning it showed a finished shift
    // while the morning crew was on the floor. It leads with now; last
    // night is one click away under Store operations.
    const opsRoll = (rows: typeof opsShifts) => {
      if (rows.length === 0) return null;
      const sum = (f: (o: (typeof rows)[number]) => number) => rows.reduce((a, o) => a + f(o), 0);
      return {
        shifts: rows.length,
        open: rows.filter((o) => o.status === 'ACTIVE').length,
        sopDone: sum((o) => o.sopDone),
        sopTotal: sum((o) => o.sopTotal),
        taskDone: sum((o) => o.taskDone),
        taskTotal: sum((o) => o.taskTotal),
        tempAlerts: sum((o) => o.tempAlerts),
        // Submitted incomplete by a person; the expiry sweep's closes are
        // "never submitted", counted apart (LEAD-2).
        incomplete: rows.filter((o) => o.closedIncomplete && !runExpired(o)).length,
        expired: rows.filter((o) => runExpired(o)).length,
        photos: sum((o) => o._count.tasks),
      };
    };

    /** On the floor at this moment, whatever day it was filed under. */
    const opsLive = opsShifts
      .filter((o) => o.status === 'ACTIVE')
      .map((o) => ({
        id: o.id,
        department: o.department,
        period: o.period,
        openedAt: o.openedAt.toISOString(),
        sopDone: o.sopDone,
        sopTotal: o.sopTotal,
      }))
      .slice(0, 6);

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
        incomplete: rows.filter((o) => o.closedIncomplete && !runExpired(o)).length,
        expired: rows.filter((o) => runExpired(o)).length,
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

    // Nothing filed today: say what is planned, not "evidence appears once
    // checklists run" at a store that runs them (F500 G5). The next
    // checklist still to start today, and whether the store ever ran one.
    let opsPlan: {
      everRan: boolean;
      next: { department: string; windowLabel: string; startsAt: string } | null;
      missedToday: number;
    } | null = null;
    if (!opsShifts.some((o) => o.dateKey === opsTodayKey || o.status === 'ACTIVE')) {
      const [ever, plan] = await Promise.all([
        prisma.opsShift.findFirst({ where: opsWhere, select: { id: true } }),
        buildStoreOps(scope, { dateKey: todayKey, cal, now }).catch(() => null),
      ]);
      const waiting = (plan?.grid ?? [])
        .flatMap((g) => g.cells.flatMap((c) => c.expected.map((e) => ({ department: g.department, ...e }))))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const next = waiting.find((e) => !e.missed && Date.parse(e.endsAt) > now.getTime()) ?? null;
      opsPlan = {
        everRan: !!ever,
        next: next ? { department: next.department, windowLabel: next.windowLabel, startsAt: next.startsAt } : null,
        missedToday: waiting.filter((e) => e.missed).length,
      };
    }
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
        // Today's shifts are the ones that START today on the store's clock —
        // the Schedule's day. The roster also lists last night's overnight
        // still finishing, but it is last night's shift: counted here it read
        // "12 filled" beside Schedule's "10 of 11" for the same day (LEAD-3).
        filled: todayShifts.filter((s) => s.status !== 'OPEN' && cal.key(s.startsAt) === todayKey).length,
        open: todayShifts.filter((s) => s.status === 'OPEN' && cal.key(s.startsAt) === todayKey).length,
      },
      week: {
        start: thisWeekKey,
        end: nextKey(thisWeekKey, 6),
        days: dayKeys.map((k) => dayMap.get(k)!),
        filled: thisWeek.filled,
        open: thisWeek.total - thisWeek.filled,
        fillRatePct:
          thisWeek.total > 0 ? Math.round((thisWeek.filled / thisWeek.total) * 100) : null,
        /** Staffed shift hours this week, gross (meal breaks in) — the contract's basis. */
        hours: Math.round((weekMinutes / 60) * 10) / 10,
        /** The same staffed shifts, paid time (unpaid meal breaks out) — the punches' basis. */
        paidHours: Math.round((weekPaidMinutes / 60) * 10) / 10,
        /** Punched so far this week, breaks out. */
        workedHours: Math.round((workedMinutes / 60) * 10) / 10,
        /** Contracted person-hours for the whole week (windowed targets × 7 days); null without windows. */
        contractedHours: weeklyContractHours(targetLocations),
      },
      tomorrow: {
        confirmed: tomorrowShifts.filter((s) => s.status === 'ASSIGNED' && s.acknowledgedAt !== null)
          .length,
        unconfirmed: tomorrowShifts.filter(
          (s) => s.status === 'ASSIGNED' && s.acknowledgedAt === null,
        ).length,
        open: tomorrowShifts.filter((s) => s.status === 'OPEN').length,
        coverInFlight: new Set(pendingTomorrowClaims.map((c) => c.shiftId)).size,
        /** People the contract asks for tomorrow (each window's headcount summed), or null with no target. */
        target: dailyContract(tomorrowTargets),
      },
      leads: { people: leads, supportEmail: orgSetting?.supportEmail ?? null },
      ops:
        opsShifts.length > 0
          ? {
              yesterday: opsDay(opsYesterdayKey),
              today: opsDay(opsTodayKey),
              /** Running right now — the answer to "what is happening". */
              live: opsLive,
              /** Today's work including an overnight that carried into it. */
              current: opsRoll(
                opsShifts.filter((o) => o.dateKey === opsTodayKey || o.status === 'ACTIVE'),
              ),
              /** Last night's overnight, specifically — the thing the old
               *  card was really showing, now reachable on purpose. */
              lastNight: opsRoll(
                opsShifts.filter((o) => o.dateKey === opsYesterdayKey && o.period === 'OVERNIGHT'),
              ),
              todayKey: opsTodayKey,
              yesterdayKey: opsYesterdayKey,
            }
          : null,
      opsPlan,
      reliability: { weeks, grade: graded.grade, score: graded.score, basis: graded.basis },
      clearance,
      statements: statements.map((st) => ({
        ...portalStatementRow(st, {
          scope,
          singleStore,
          todayKey,
          pdfUrl: (id) => withPreview(`/api/client-portal/statements/${id}.pdf`),
        }),
        reviewed: reviewed('STATEMENT', st.id),
      })),
      // Every unpaid statement, said once: "Open balance $5,760.00 · 2
      // statements", and the past-due ones Needs you leads with. Amounts
      // follow the rows' rule (null where the account can't see them).
      balance: (() => {
        const rows = unpaid.map((st) => portalStatementRow(st, { scope, singleStore, todayKey, pdfUrl: () => '' }));
        const amountOf = (r: (typeof rows)[number]) => (scope.locationId ? r.storeAmount : r.amount);
        const sumOf = (list: typeof rows) =>
          list.every((r) => amountOf(r) !== null) ? Math.round(list.reduce((a, r) => a + (amountOf(r) ?? 0), 0) * 100) / 100 : null;
        const pastDue = rows.filter((r) => r.daysPastDue !== null);
        return {
          count: rows.length,
          amount: rows.length ? sumOf(rows) : 0,
          pastDue: pastDue.length,
          pastDueAmount: pastDue.length ? sumOf(pastDue) : 0,
          oldestDaysPastDue: pastDue.reduce<number | null>((m, r) => (m === null || (r.daysPastDue ?? 0) > m ? r.daysPastDue : m), null),
          /** The one statement to open when only one is past due. */
          pastDueIds: pastDue.map((r) => r.id),
        };
      })(),
      candidatesWaiting,
      requests: (() => {
        const overdue = requestRows.filter((r) => r.status !== 'RESOLVED');
        const answered = requestRows.filter((r) => r.status === 'RESOLVED');
        const oldest = overdue.reduce<Date | null>((m, r) => (r.dueAt && (!m || r.dueAt < m) ? r.dueAt : m), null);
        return {
          overdue: overdue.length,
          overdueDays: oldest ? Math.max(1, Math.floor((now.getTime() - oldest.getTime()) / DAY)) : null,
          overdueId: overdue[0]?.id ?? null,
          answered: answered.length,
          answeredId: answered[answered.length - 1]?.id ?? null,
        };
      })(),
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
        reviewed: reviewed('SERVICE_REPORT', serviceReportKey(scope, lastCompletedWeek)),
        /** Anything scheduled that week — an empty week's report is not a task (lib/portalNeedsYou). */
        hadShifts: (weekAgg.get(lastCompletedWeek)?.total ?? 0) > 0,
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

    const [rows, live, carry] = await Promise.all([
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
      // The week before's last overnight, still on the floor in Saturday's
      // first hours: the heatmap counts it there (LEAD-3). Hours only.
      prisma.shift.findMany({
        where: {
          ...shiftScope(scope),
          startsAt: { gte: new Date(weekStart.getTime() - DAY), lt: weekStart },
          endsAt: { gt: weekStart },
        },
        select: { startsAt: true, endsAt: true, status: true, locationRel: { select: { timezone: true } } },
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
      /** Shifts from the evening before the week that run into its first day — for the heatmap's hours only. */
      carryIn: carry.map((s) => ({
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        timezone: s.locationRel?.timezone ?? ORG_TZ,
        state: s.status === 'OPEN' ? ('open' as const) : ('done' as const),
      })),
      filled: rows.filter((r) => r.status !== 'OPEN').length,
      open: rows.filter((r) => r.status === 'OPEN').length,
      // The contracted windows (store-local minutes; end <= start wraps
      // midnight), so the heatmap marks every contracted hour that is short —
      // a day with nothing scheduled against a contract of 8 used to look
      // neutral (F500 G5). Headcounts only.
      targets: (await loadTargets(scope, now)).flatMap((l) =>
        l.windows.map((w) => ({ locationId: l.id, label: w.label, startMinute: w.start, endMinute: w.end, headcount: w.count })),
      ),
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
      // The statement is billed per client: its lines, totals and store
      // breakdown cover every location. A store account has no business
      // holding another store's labour spend, so this document is for
      // client-wide accounts only. Their own store's hours and amount are
      // on the portal already, taken from the statement's store line.
      // At a client with ONE store the statement is that store's alone, so
      // its manager holds it too (F500 G5).
      if (scope.locationId && !(await singleStoreClient(scope.clientId))) {
        throw new HttpError(
          403,
          'statement_is_client_wide',
          'This statement covers every store on the account. Your store’s hours and amount are shown on your dashboard.',
        );
      }
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
        ...(await statementContext(prisma, { statementId: row.id, clientId: row.clientId, tenantId: row.tenantId ?? tenantIdForWrite() })),
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="statement-${toDateOnly(row.periodStart)}${
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
          // The phone rides along only for the shift supervisor (below); a
          // store account never sees it.
          assignedAssociate: { select: { firstName: true, lastName: true, phone: true, photoS3Key: true, photoUpdatedAt: true, user: { select: { id: true, status: true, deletedAt: true } } } },
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
              associate: { select: { firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true } },
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
      // Order matters: a punch outranks a no-show event, so someone who
      // clocked in late is never shown to the store as "missed".
      if (s.status === 'OPEN') state = 'open';
      else if (punch && punch.clockOutAt === null && !ended) state = 'on-floor';
      else if (punch) state = 'worked';
      else if (ncns.has(s.id) || ended) state = 'missed';
      else if (started) state = 'not-in';
      else state = s.acknowledgedAt ? 'confirmed' : 'unconfirmed';
      return {
        shiftId: s.id,
        associateId: s.assignedAssociateId,
        name: s.assignedAssociate ? fullName(s.assignedAssociate) : null,
        // The face wall asks for a photo only when one is on file (null: initials, no request).
        photoUrl: s.assignedAssociateId && s.assignedAssociate ? profilePhotoUrlFor({ id: s.assignedAssociateId, ...s.assignedAssociate }) : null,
        // Field roles (2026-10): the shift supervisor reaches their crew
        // from the face wall — call, text, message. Nobody else gets the
        // number here: not the store, not the watch-only floor lead.
        ...(req.user!.role === 'SHIFT_SUPERVISOR' && s.assignedAssociate?.phone ? { phone: s.assignedAssociate.phone } : {}),
        ...(req.user!.role === 'SHIFT_SUPERVISOR' && s.assignedAssociate?.user && s.assignedAssociate.user.status === 'ACTIVE' && !s.assignedAssociate.user.deletedAt
          ? { messageUserId: s.assignedAssociate.user.id }
          : {}),
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

    // A day with no shifts says when the next one is (F500 G2), within the
    // same scope: published shifts only, the first after this day ends.
    const nextShift =
      rows.length === 0
        ? await prisma.shift.findFirst({
            where: { ...shiftScope(scope), startsAt: { gte: dayEnd } },
            orderBy: { startsAt: 'asc' },
            select: { startsAt: true, endsAt: true, position: true, locationRel: { select: { timezone: true } } },
          })
        : null;

    res.json({
      ...(rows.length === 0
        ? {
            nextShift: nextShift
              ? {
                  startsAt: nextShift.startsAt.toISOString(),
                  endsAt: nextShift.endsAt.toISOString(),
                  position: nextShift.position,
                  timezone: nextShift.locationRel?.timezone ?? scope.location?.timezone ?? ORG_TZ,
                }
              : null,
          }
        : {}),
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
        photoUrl: profilePhotoUrlFor({ id: e.associateId, ...e.associate }),
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
/**
 * GET /client-portal/ops?date=YYYY-MM-DD — store operations for one store
 * day: every department's SOP by shift, what needs attention, the
 * temperature log, production and handoffs (lib/portalOps). The store's
 * team leads read it too — operations carry no money.
 */
clientPortalRouter.get('/client-portal/ops', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query, { floorLead: true });
    const now = new Date();
    const cal = await portalCalendar(scope);
    const dateKey = req.query.date === undefined ? cal.key(now) : parseDayKey(req.query.date, 'date');
    // The two narrowings a store manager actually asks for: which shift,
    // and which department. "What happened overnight" is a filter, not a
    // different page.
    const periodRaw = req.query.period?.toString();
    const period =
      periodRaw && ['MORNING', 'EVENING', 'CLOSING', 'OVERNIGHT'].includes(periodRaw)
        ? (periodRaw as OpsPeriod)
        : null;
    const department = req.query.department?.toString()?.slice(0, 80) || null;
    const body = await buildStoreOps(scope, { dateKey, cal, now, period, department });
    res.json({
      scope: { client: scope.client, location: scope.location ? { id: scope.location.id, name: scope.location.name } : null },
      ...body,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /client-portal/ops/photos/:id — SOP photo evidence, in scope. */
clientPortalRouter.get('/client-portal/ops/photos/:id', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query, { floorLead: true });
    const photo = await scopedOpsPhoto(scope, req.params.id);
    if (!photo) throw new HttpError(404, 'not_found', 'Photo not found');
    const buf = await getBlobStore().get(photo.s3Key);
    if (!buf) throw new HttpError(404, 'blob_missing', 'Photo file is missing.');
    res.setHeader('Content-Type', photo.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

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

    // No silent caps (CODE-19): every row is read in pages, or aggregated in
    // SQL; `truncated` says so if a hard ceiling ever stops a read.
    const { rows: shifts, truncated: shiftsCut } = await readAll((page) =>
      prisma.shift.findMany({
        where: { ...shiftScope(scope), startsAt: { gte: from, lt: toExclusive } },
        select: { id: true, locationId: true, startsAt: true, endsAt: true, status: true, assignedAssociateId: true },
        ...page,
      }),
    );
    const shiftIds = shifts.map((s) => s.id);
    // Same store clamp as the overview: Store Ops is a per-building record.
    const opsWhere = await opsShiftScope(scope);
    const dayKeys = new Set<string>();
    for (let k = fromKey; k <= toKey; k = nextKey(k, 1)) dayKeys.add(k);

    const eventWhere = { ...attendanceWhere(scope, from, shiftIds), occurredOn: { gte: from, lt: toExclusive } };
    const opsRangeWhere = { ...opsWhere, dateKey: { in: [...dayKeys] } };
    const [eventKinds, ncnsRead, { punched, entries: rangeEntries, truncated: punchesCut }, workedRead, claims, opsAgg, opsIncomplete, opsPhotos, incidents, openIncidents, statements] =
      await Promise.all([
        // Counted in SQL, by kind.
        prisma.attendanceEvent.groupBy({ by: ['kind'], where: eventWhere, _count: { _all: true } }),
        // The no-show shifts themselves, which the showed-up rate excludes.
        readAll((page) =>
          prisma.attendanceEvent.findMany({ where: { ...eventWhere, kind: 'NO_CALL_NO_SHOW' }, select: { id: true, shiftId: true }, ...page }),
        ),
        loadPunches(scope, from, toExclusive, now),
        readAll((page) =>
          prisma.timeEntry.findMany({
            where: {
              ...entryScope(scope),
              status: { in: ['COMPLETED', 'APPROVED'] },
              clockInAt: { gte: from, lt: toExclusive },
            },
            select: {
              id: true,
              clockInAt: true,
              clockOutAt: true,
              breaks: { select: { startedAt: true, endedAt: true } },
            },
            ...page,
          }),
        ),
        prisma.openShiftClaim.count({
          where: {
            status: 'APPROVED',
            decidedAt: { gte: from, lt: toExclusive },
            shift: { clientId: scope.clientId, ...(scope.locationId ? { locationId: scope.locationId } : {}) },
          },
        }),
        // The checklist roll-up, summed in SQL.
        prisma.opsShift.aggregate({
          where: opsRangeWhere,
          _count: { _all: true },
          _sum: { sopDone: true, sopTotal: true, taskDone: true, taskTotal: true, tempAlerts: true },
        }),
        // Submitted short by a person; the expiry sweep's closes (no closer) are "never submitted".
        prisma.opsShift.groupBy({
          by: ['closedById'],
          where: { ...opsRangeWhere, closedIncomplete: true, status: 'CLOSED' },
          _count: { _all: true },
        }),
        prisma.opsTask.count({ where: { opsShift: { is: opsRangeWhere }, photos: { some: {} } } }),
        prisma.oshaIncident.count({
          where: { ...incidentWhere(scope), occurredAt: { gte: from, lt: toExclusive } },
        }),
        prisma.oshaIncident.count({
          where: {
            ...incidentWhere(scope),
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
            finalizedAt: true,
            paidAt: true,
            dueAt: true,
            poNumber: true,
            snapshot: true,
          },
        }),
      ]);

    const ncnsIds = new Set(ncnsRead.rows.filter((e) => e.shiftId).map((e) => e.shiftId));
    const worked = workedRead.rows;
    const truncated = shiftsCut || punchesCut || ncnsRead.truncated || workedRead.truncated;
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
    const [reviewed, singleStore] = await Promise.all([loadAcknowledgements(scope.clientId), singleStoreClient(scope.clientId)]);
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
      const locations = await prisma.site.findMany({
        where: { clientId: scope.clientId, deletedAt: null, isActive: true },
        select: { id: true, name: true },
        take: 200,
      });
      if (locations.length > 1) {
        // The shifts already carry their store: a second capped read of the
        // same rows for their locationId was the third silent cap here.
        storeRows = locations
          .map((l) => {
            const mine = shifts.filter((s) => s.locationId === l.id);
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
      else {
        d.filled += 1;
        // Staffed shifts' paid time — the basis worked hours are counted on
        // (breaks out); an open slot is not hours anyone was scheduled for.
        d.scheduledHours += paidMinutesForRange(s.startsAt, s.endsAt) / 60;
      }
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
    const count = (kind: string) => eventKinds.find((e) => e.kind === kind)?._count._all ?? 0;
    const opsCount = opsAgg._count._all;
    const expiredOps = opsIncomplete.find((g) => g.closedById === null)?._count._all ?? 0;
    const incompleteOps = opsIncomplete.reduce((a, g) => a + g._count._all, 0) - expiredOps;

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
      /** True only when a read hit the hard ceiling — the figures are then partial. */
      truncated,
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
        // Every punched hour at the store, scheduled or not (uncapped). The
        // grade's "delivered" above is capped at the contract each hour —
        // two different numbers, so they carry two different names, and the
        // hours worked past the schedule are said, not hidden in a full
        // meter ("444.1h of 56.5h scheduled", F500 G5).
        workedHours: Math.round(sum((d) => d.workedHours) * 10) / 10,
        offScheduleHours: Math.max(0, Math.round((sum((d) => d.workedHours) - sum((d) => d.scheduledHours)) * 10) / 10),
      },
      incidents: {
        noCallNoShows: count('NO_CALL_NO_SHOW'),
        callOuts: count('CALL_OUT'),
        lates: count('LATE'),
        replacementsFound: claims,
      },
      ops:
        opsCount > 0
          ? {
              shifts: opsCount,
              sopDone: opsAgg._sum.sopDone ?? 0,
              sopTotal: opsAgg._sum.sopTotal ?? 0,
              taskDone: opsAgg._sum.taskDone ?? 0,
              taskTotal: opsAgg._sum.taskTotal ?? 0,
              tempAlerts: opsAgg._sum.tempAlerts ?? 0,
              incomplete: incompleteOps,
              expired: expiredOps,
              photos: opsPhotos,
            }
          : null,
      safety: { incidents, open: openIncidents },
      // The same row the home shows (portalStatementRow): amount, due date,
      // days past due, the PDF where the account may hold it.
      statements: statements.map((st) => ({
        ...portalStatementRow(st, {
          scope,
          singleStore: singleStore,
          todayKey: cal.key(now),
          pdfUrl: (id) => `/api/client-portal/statements/${id}.pdf${previewQs ? `?${previewQs.slice(1)}` : ''}`,
        }),
        reviewed: reviewed('STATEMENT', st.id),
      })),
      serviceReports: weekStarts.map((w) => ({
        weekStart: w,
        weekEnd: nextKey(w, 6),
        url: `/api/client-portal/service-report.pdf?week=${w}${previewQs}`,
        // A week still under way has no report to sign off yet: the PDF is
        // "so far", and "Mark reviewed" waits for the Saturday after.
        complete: nextKey(w, 7) <= cal.key(now),
        reviewed: reviewed('SERVICE_REPORT', serviceReportKey(scope, w)),
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
    } else if (nextKey(input.key, 7) > orgDateKey(new Date())) {
      // Only a finished week is reviewable — signing off a week that is
      // still being worked would vouch for shifts that have not happened.
      throw new HttpError(409, 'week_in_progress', 'This week is still under way. Its report can be reviewed once the week ends.');
    }
    // The caller sends the week; the store comes from their own account,
    // never from the request, so one store can never sign for another.
    const subjectKey =
      input.kind === 'SERVICE_REPORT'
        ? serviceReportKey({ locationId: req.user!.locationId ?? null }, input.key)
        : input.key;
    const existing = await prisma.clientAcknowledgement.findUnique({
      where: { clientId_kind_subjectKey: { clientId, kind: input.kind, subjectKey } },
      include: { user: { select: { associate: { select: { firstName: true } }, email: true } } },
    });
    const row =
      existing ??
      (await prisma.clientAcknowledgement.create({
        data: { clientId, kind: input.kind, subjectKey, userId: req.user!.id },
        include: { user: { select: { associate: { select: { firstName: true } }, email: true } } },
      }));
    res.status(existing ? 200 : 201).json({
      kind: row.kind,
      key: input.key,
      reviewedAt: row.createdAt.toISOString(),
      reviewedBy: reviewerName(row.user),
    });
  } catch (err) {
    next(err);
  }
});

/* ===== The week's hours, signed off ====================================== */

/**
 * The store a sign-off is about. Hours are signed store by store: a store
 * account's own store (never one named in the request), a client-wide or
 * region account's store when it names one inside its reach (resolveScope
 * checks), or a one-store client's only store.
 */
async function signOffStore(scope: PortalScope) {
  if (scope.location) return { id: scope.location.id, name: scope.location.name, timezone: scope.location.timezone };
  const stores = await prisma.site.findMany({
    where: { clientId: scope.clientId, deletedAt: null, isActive: true },
    select: { id: true, name: true, timezone: true },
    take: 2,
  });
  if (stores.length === 1) return stores[0]!;
  throw new HttpError(400, 'store_required', 'Pick a store: hours are signed off store by store.');
}

/**
 * GET /client-portal/hours?week=YYYY-MM-DD — a finished store week's worked
 * hours, person by person, and its sign-off. `week` is any day in the week
 * (default: the last finished week). Hours only — no rates.
 */
clientPortalRouter.get('/client-portal/hours', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query);
    const store = await signOffStore(scope);
    const cal = storeCalendar(store.timezone);
    const now = new Date();
    const weekKey = req.query.week === undefined ? lastFinishedWeek(cal, now) : storeWeekKey(cal, parseDayKey(req.query.week, 'week'));
    const [hours, record] = await Promise.all([
      storeWeekHours({ clientId: scope.clientId, locationId: store.id }, cal, weekKey, now),
      prisma.clientHoursSignOff.findUnique({
        where: { tenantId_locationId_weekStart: { tenantId: tenantIdForWrite(), locationId: store.id, weekStart: weekDate(weekKey) } },
      }),
    ]);
    res.json({
      store: { id: store.id, name: store.name },
      week: { start: weekKey, end: nextKey(weekKey, 6) },
      /** The other weeks that can be signed, newest first. */
      weeks: Array.from({ length: SIGNOFF_LOOKBACK_WEEKS }, (_, i) => nextKey(lastFinishedWeek(cal, now), -7 * i)),
      signable: signableWeek(cal, weekKey, now),
      // Only the client signs its hours; an admin's preview reads them.
      canSign: req.user!.role === 'CLIENT_PORTAL',
      ...hours,
      state: signOffState(hours, record),
      signOff: signOffView(record),
    });
  } catch (err) {
    next(err);
  }
});

const SignHoursSchema = z.object({
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The lines the manager questions, each with why. Empty = signed as is. */
  flags: z
    .array(z.object({ associateId: z.string().uuid(), note: z.string().trim().min(3).max(500) }))
    .max(500)
    .default([]),
  note: z.string().trim().max(1000).optional(),
  /** The total the manager reviewed: if the hours moved meanwhile, nothing is signed. */
  expectTotalHours: z.number().nonnegative().optional(),
});

/**
 * POST /client-portal/hours/sign — the client signs a finished store week's
 * hours off, or flags lines. Re-signing replaces the record. Client accounts
 * only, and only stores inside their own reach (resolveScope).
 */
clientPortalRouter.post('/client-portal/hours/sign', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'CLIENT_PORTAL') {
      throw new HttpError(403, 'client_only', 'Only the client signs its hours off.');
    }
    const input = SignHoursSchema.parse(req.body);
    const scope = await resolveScope(req.user!, req.query);
    const store = await signOffStore(scope);
    const cal = storeCalendar(store.timezone);
    const now = new Date();
    const weekKey = storeWeekKey(cal, input.week);
    if (!signableWeek(cal, weekKey, now)) {
      throw new HttpError(
        409,
        'week_not_signable',
        weekKey >= cal.key(cal.weekStart(now))
          ? 'This week is still under way. Its hours can be signed off once the week ends.'
          : `Only the last ${SIGNOFF_LOOKBACK_WEEKS} weeks can be signed off.`,
      );
    }
    const hours = await storeWeekHours({ clientId: scope.clientId, locationId: store.id }, cal, weekKey, now);
    if (input.expectTotalHours !== undefined && Math.abs(input.expectTotalHours - hours.totalHours) > 0.005) {
      throw new HttpError(409, 'hours_changed', 'The hours changed while you were reviewing them. Reload and sign again.');
    }
    const byId = new Map(hours.lines.map((l) => [l.associateId, l]));
    const flags: SignOffFlag[] = [];
    for (const f of input.flags) {
      const line = byId.get(f.associateId);
      if (!line) throw new HttpError(400, 'unknown_line', 'A flagged line is not in this week’s hours.');
      flags.push({ associateId: line.associateId, name: line.name, hours: line.hours, note: f.note });
    }
    // The name the account carries (its invite's display name) — never an email as a name.
    const signedByName =
      [req.user!.firstName, req.user!.lastName].filter(Boolean).join(' ').trim() ||
      (scope.location && req.user!.locationId ? 'Store manager' : 'Client manager');
    const data = {
      clientId: scope.clientId,
      status: flags.length > 0 ? ('FLAGGED' as const) : ('SIGNED' as const),
      signedById: req.user!.id,
      signedByName: signedByName.slice(0, 200),
      signedAt: now,
      totalHours: hours.totalHours,
      people: hours.people,
      lines: hours.lines as unknown as Prisma.InputJsonValue,
      flags: flags as unknown as Prisma.InputJsonValue,
      note: input.note || null,
    };
    const tenantId = tenantIdForWrite();
    const record = await prisma.clientHoursSignOff.upsert({
      where: { tenantId_locationId_weekStart: { tenantId, locationId: store.id, weekStart: weekDate(weekKey) } },
      create: { tenantId, locationId: store.id, weekStart: weekDate(weekKey), ...data },
      update: data,
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: scope.clientId,
        action: flags.length > 0 ? 'client.hours_flagged' : 'client.hours_signed_off',
        entityType: 'ClientHoursSignOff',
        entityId: record.id,
        metadata: { locationId: store.id, week: weekKey, totalHours: hours.totalHours, people: hours.people, flags: flags.length },
      },
      'clients.hours_signoff',
    );
    // A flag is a question from the client: the desks that answer it hear it.
    if (flags.length > 0) {
      void trackNotificationWork(
        notifyRoles(DOWNLOAD_ROLES, {
          subject: `${store.name}: ${flags.length} ${flags.length === 1 ? 'line' : 'lines'} of hours questioned`,
          body:
            `${signedByName} flagged hours for ${fmtDayRange(weekKey, nextKey(weekKey, 6))} at ${store.name}:\n` +
            flags.map((f) => `· ${f.name} (${f.hours}h): ${f.note}`).join('\n'),
          linkUrl: `/clients/${scope.clientId}?section=overview`,
          category: ENGAGEMENT_CATEGORY,
        }).then(() => undefined),
      );
    }
    res.status(201).json({
      week: { start: weekKey, end: nextKey(weekKey, 6) },
      state: signOffState(hours, record),
      signOff: signOffView(record),
    });
  } catch (err) {
    next(err);
  }
});

/* ===== Candidates to review ============================================== */

/**
 * GET /client-portal/candidates — the people Alto has put forward for this
 * client to approve or pass on: waiting ones first, then the last 60 days
 * of answers. A store account sees those for its store and those put to
 * the whole client.
 *
 * PRIVACY: a candidate is not yet anyone's employee. The client sees the
 * name, the position, Alto's pitch and how Alto's interviewers
 * recommended them — never contact details, a résumé or interview notes.
 */
clientPortalRouter.get('/client-portal/candidates', requireAuth, async (req, res, next) => {
  try {
    const scope = await resolveScope(req.user!, req.query);
    const since = new Date(Date.now() - 60 * DAY);
    const rows = await prisma.candidateSubmittal.findMany({
      where: {
        clientId: scope.clientId,
        candidate: { deletedAt: null },
        AND: [
          { OR: [{ status: 'PENDING' }, { status: { in: ['APPROVED', 'DECLINED'] }, decidedAt: { gte: since } }] },
          ...(scope.locationId ? [{ OR: [{ locationId: null }, { locationId: scope.locationId }] }] : []),
        ],
      },
      select: {
        id: true,
        pitch: true,
        status: true,
        feedback: true,
        decidedAt: true,
        createdAt: true,
        location: { select: { name: true } },
        submittedBy: { select: { email: true, associate: { select: { firstName: true } } } },
        decidedBy: { select: { email: true, associate: { select: { firstName: true } } } },
        candidate: {
          select: {
            firstName: true,
            lastName: true,
            position: true,
            interviews: { where: { completedAt: { not: null } }, select: { rating: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const view = rows.map((r) => ({
      id: r.id,
      name: `${r.candidate.firstName} ${r.candidate.lastName}`,
      position: r.candidate.position,
      storeName: r.location?.name ?? null,
      pitch: r.pitch,
      status: r.status,
      feedback: r.feedback,
      interviewRatings: r.candidate.interviews.flatMap((i) => (i.rating == null ? [] : [i.rating])),
      submittedBy: reviewerName(r.submittedBy),
      submittedAt: r.createdAt.toISOString(),
      decidedBy: reviewerName(r.decidedBy),
      decidedAt: r.decidedAt?.toISOString() ?? null,
    }));
    view.sort((a, b) => Number(b.status === 'PENDING') - Number(a.status === 'PENDING'));
    res.json({
      canDecide: req.user!.role === 'CLIENT_PORTAL',
      candidates: view,
    });
  } catch (err) {
    next(err);
  }
});

const CandidateDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'DECLINED']),
  feedback: z.string().trim().max(2000).optional(),
});

/**
 * POST /client-portal/candidates/:id/decision — the client approves a
 * candidate or passes, with feedback. Portal accounts only: a preview
 * can't answer for the client. The answer lands on the candidate's
 * timeline and tells the recruiter who put them forward.
 */
clientPortalRouter.post('/client-portal/candidates/:id/decision', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    if (user.role !== 'CLIENT_PORTAL') {
      throw new HttpError(403, 'forbidden', 'Only a client account can answer for the client.');
    }
    const input = CandidateDecisionSchema.parse(req.body);
    if (input.decision === 'DECLINED' && !input.feedback) {
      throw new HttpError(400, 'feedback_required', 'Tell Alto why, so the next person is a better fit.');
    }
    const s = await prisma.candidateSubmittal.findUnique({
      where: { id: req.params.id },
      include: {
        client: { select: { name: true } },
        location: { select: { name: true, regionId: true, orgUnit: { select: { path: true } } } },
        candidate: { select: { firstName: true, lastName: true, deletedAt: true } },
      },
    });
    // Theirs to answer: their client, and — for a store account — their
    // store or one put to the whole client. A region account answers for
    // the stores in its region. Anything else is a 404, not a 403: it
    // doesn't exist for them.
    const theirs =
      s &&
      !s.candidate.deletedAt &&
      (user.clientId
        ? s.clientId === user.clientId && (!user.locationId || !s.locationId || s.locationId === user.locationId)
        : Boolean(user.regionId && s.location?.orgUnit?.path && (await regionUnitPath(prisma, user.regionId)) && s.location.orgUnit.path.startsWith((await regionUnitPath(prisma, user.regionId))!)));
    if (!s || !theirs) throw new HttpError(404, 'not_found', 'Candidate not found');
    if (s.status !== 'PENDING') {
      throw new HttpError(409, 'already_decided', s.status === 'WITHDRAWN' ? 'Alto withdrew this candidate.' : 'Already answered.');
    }
    const feedback = input.feedback || null;
    const decidedAt = new Date();
    await prisma.$transaction(async (tx) => {
      // Conditional on PENDING so two managers answering at once can't
      // both win.
      const n = await tx.candidateSubmittal.updateMany({
        where: { id: s.id, status: 'PENDING' },
        data: { status: input.decision, feedback, decidedById: user.id, decidedAt },
      });
      if (n.count === 0) throw new HttpError(409, 'already_decided', 'Already answered.');
      const who = s.location ? `${s.client.name} · ${s.location.name}` : s.client.name;
      await recordCandidateEvent(tx, {
        candidateId: s.candidateId,
        kind: 'CLIENT_FEEDBACK',
        actorUserId: user.id,
        // The verdict, then their words on a line of their own.
        body: `${input.decision === 'APPROVED' ? 'Approved' : 'Passed'} by ${who}${feedback ? `\n${feedback}` : ''}`,
        metadata: { submittalId: s.id, decision: input.decision },
      });
    });
    auditRecruiting(req, 'client_feedback', 'CandidateSubmittal', s.id, {
      candidateId: s.candidateId,
      decision: input.decision,
    });
    if (s.submittedById) {
      const name = `${s.candidate.firstName} ${s.candidate.lastName}`;
      void notifyUser(s.submittedById, {
        subject: input.decision === 'APPROVED' ? `${s.client.name} approved ${name}` : `${s.client.name} passed on ${name}`,
        body: feedback ?? (input.decision === 'APPROVED' ? 'Ready for an offer.' : 'No reason given.'),
        category: 'recruiting',
        linkUrl: `/recruiting?candidateId=${s.candidateId}`,
      }).catch(() => undefined);
    }
    res.json({ id: s.id, status: input.decision, decidedAt: decidedAt.toISOString() });
  } catch (err) {
    next(err);
  }
});

