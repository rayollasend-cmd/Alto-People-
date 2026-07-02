import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  AdminOpenShiftClaimListResponseSchema,
  AssociateListResponseSchema,
  AutoFillResponseSchema,
  AutoScheduleWeekInputSchema,
  AutoScheduleWeekResponseSchema,
  AvailabilityExceptionCreateInputSchema,
  AvailabilityExceptionListResponseSchema,
  AvailabilityListResponseSchema,
  AvailabilityReplaceInputSchema,
  BulkCreateShiftsInputSchema,
  BulkCreateShiftsResponseSchema,
  CalendarFeedUrlResponseSchema,
  CopyWeekInputSchema,
  MyShiftDetailResponseSchema,
  MyShiftHistoryResponseSchema,
  OpenShiftClaimSchema,
  OpenShiftsResponseSchema,
  PublishWeekInputSchema,
  PublishWeekResponseSchema,
  ScheduleExportInputSchema,
  ShiftAssignInputSchema,
  ShiftCancelInputSchema,
  ShiftConflictsResponseSchema,
  ShiftCreateInputSchema,
  ShiftListResponseSchema,
  ShiftSwapListResponseSchema,
  ShiftTemplateApplyInputSchema,
  ShiftTemplateCreateInputSchema,
  ShiftTemplateListResponseSchema,
  ShiftUpdateInputSchema,
  SwapCandidateListResponseSchema,
  SwapCreateInputSchema,
  SwapDecideInputSchema,
  TradeOptionsResponseSchema,
  type AutoFillCandidate,
  type AutoScheduleSkip,
  type AutoScheduleWeekResponse,
  type BulkCreateShiftsResponse,
  type AvailabilityWindow,
  type CopyWeekResponse,
  type PublishWeekResponse,
  type PublishWeekSkip,
  type Shift,
  type ShiftConflict,
  type ShiftListResponse,
  type ShiftSwapRequest as ShiftSwapRequestDTO,
  type ShiftTemplate as ShiftTemplateDTO,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeShifts } from '../lib/scope.js';
import { firstLocationForClient } from '../lib/firstLocationForClient.js';
import { enqueueAudit, recordShiftEvent } from '../lib/audit.js';
import { formatShiftLine, notifyShift } from '../lib/notifyShift.js';
import { notifyAllAdmins, notifyManager } from '../lib/notify.js';
import { shiftSwapManagerTemplate } from '../lib/emailTemplates.js';
import { netWorkedMinutes, startOfWeekUTC, endOfWeekUTC } from '../lib/timeAnomalies.js';
import {
  DEFAULT_TIMEZONE,
  zonedDayOfWeek,
  zonedMinutes,
} from '../lib/timezone.js';
import {
  evaluateShiftNotice,
  isPublishingTransition,
} from '../lib/predictiveScheduling.js';
import { renderSchedulePdf } from '../lib/scheduleReport.js';
import { mintCalendarToken } from '../lib/calendarFeed.js';
import { env } from '../config/env.js';

export const schedulingRouter = Router();

const MANAGE = requireCapability('manage:scheduling');

// Reported 2026-05-02: scheduling pickers were listing every Associate
// regardless of role or status, including managers (who use a separate
// system) and terminated/uninvited people. Schedulable pool requires:
//   1. User account ACTIVE with ASSOCIATE role (excludes MANAGER, OPS,
//      HR_*, CLIENT_PORTAL, plus INVITED-but-not-yet-accepted, DISABLED).
//   2. At least one APPROVED Application — i.e. the associate has been
//      onboarded and accepted by HR. Reported 2026-05-07: pickers were
//      still showing test/junk rows whose User was ACTIVE but whose
//      onboarding was either DRAFT or never completed; mirrors the
//      `DirectoryStatus = 'ACTIVE'` derivation in /people/directory.
// Phase 131 — schedulable if there's EITHER an approved Application
// (backward-compatible legacy gate) OR an open AssociateAssignment.
// The latter catches any future case where placement diverges from
// the original application (e.g. cross-client transfer that opens an
// Assignment without re-onboarding).
const ACTIVE_ASSOCIATE_FILTER: Prisma.AssociateWhereInput = {
  deletedAt: null,
  user: { is: { status: 'ACTIVE', role: 'ASSOCIATE' } },
  OR: [
    { applications: { some: { status: 'APPROVED' } } },
    { assignments: { some: { endedAt: null } } },
  ],
};

type RawShift = Prisma.ShiftGetPayload<{
  include: {
    client: { select: { name: true } };
    assignedAssociate: { select: { firstName: true; lastName: true } };
    locationRel: { select: { id: true; name: true; timezone: true } };
  };
}>;

function scheduledMinutes(row: { startsAt: Date; endsAt: Date }): number {
  return Math.max(0, Math.floor((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000));
}

/**
 * True if `associateId` already has a non-cancelled shift overlapping
 * [startsAt, endsAt), excluding `excludeShiftId`. The double-booking guard
 * for /assign and swap approval — run inside the caller's transaction so
 * the check + write are atomic against a concurrent assignment.
 */
async function associateHasOverlap(
  tx: Prisma.TransactionClient | typeof prisma,
  associateId: string,
  startsAt: Date,
  endsAt: Date,
  excludeShiftId: string,
): Promise<boolean> {
  return hasOverlapExcluding(tx, associateId, startsAt, endsAt, [excludeShiftId]);
}

/** Overlap check excluding SEVERAL shifts — trades hand off two shifts at
 *  once, so each party's own half must not count against them. */
async function hasOverlapExcluding(
  tx: Prisma.TransactionClient | typeof prisma,
  associateId: string,
  startsAt: Date,
  endsAt: Date,
  excludeShiftIds: string[],
): Promise<boolean> {
  const clash = await tx.shift.findFirst({
    where: {
      id: { notIn: excludeShiftIds },
      assignedAssociateId: associateId,
      status: { notIn: ['CANCELLED'] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true },
  });
  return clash !== null;
}

function toShift(row: RawShift): Shift {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    position: row.position,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    location: row.location,
    hourlyRate: row.hourlyRate ? Number(row.hourlyRate) : null,
    payRate: row.payRate ? Number(row.payRate) : null,
    status: row.status,
    notes: row.notes,
    // Structured work-site (Phase 131) — powers the cascading
    // client→location filter and per-shift location display.
    locationId: row.locationId,
    locationName: row.locationRel?.name ?? null,
    // IANA timezone of the work site — lets the calendar render every shift
    // in the STORE's wall-clock time, not the viewer's browser zone. Falls
    // back to the deployment default for shifts without a Location yet.
    timezone: row.locationRel?.timezone ?? DEFAULT_TIMEZONE,
    assignedAssociateId: row.assignedAssociateId,
    assignedAssociateName: row.assignedAssociate
      ? `${row.assignedAssociate.firstName} ${row.assignedAssociate.lastName}`
      : null,
    assignedAt: row.assignedAt ? row.assignedAt.toISOString() : null,
    cancellationReason: row.cancellationReason,
    scheduledMinutes: scheduledMinutes(row),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    lateNoticeReason: row.lateNoticeReason,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
  };
}

/** "YYYY-MM-DD" of an instant as seen in `tz` — for comparing a shift's
 *  window against day-granular records (time off, availability exceptions). */
function dayKeyInZone(d: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Which of `associateIds` can't work [startsAt, endsAt) because an APPROVED
 * time-off request or a one-off availability exception covers a store-local
 * day the window touches. Day-granular records live as UTC-midnight dates,
 * so both sides compare as calendar days in the SHIFT's zone.
 */
async function blockedForWindow(
  associateIds: string[],
  startsAt: Date,
  endsAt: Date,
  tz: string,
): Promise<Set<string>> {
  if (associateIds.length === 0) return new Set();
  const startDay = new Date(`${dayKeyInZone(startsAt, tz)}T00:00:00Z`);
  const endDay = new Date(`${dayKeyInZone(endsAt, tz)}T00:00:00Z`);
  const [pto, exceptions] = await Promise.all([
    prisma.timeOffRequest.findMany({
      where: {
        associateId: { in: associateIds },
        status: 'APPROVED',
        startDate: { lte: endDay },
        endDate: { gte: startDay },
      },
      select: { associateId: true },
    }),
    prisma.availabilityException.findMany({
      where: {
        associateId: { in: associateIds },
        date: { gte: startDay, lte: endDay },
      },
      select: { associateId: true },
    }),
  ]);
  return new Set([
    ...pto.map((r) => r.associateId),
    ...exceptions.map((r) => r.associateId),
  ]);
}

const SHIFT_INCLUDE = {
  client: { select: { name: true } },
  assignedAssociate: { select: { firstName: true, lastName: true } },
  locationRel: { select: { id: true, name: true, timezone: true } },
} as const;

// Hard cap on the PDF export. Each row pulls a shift row + client name
// + associate name, ~400 bytes serialized; at 5000 rows that's ~2 MB
// of working set per request, well within Railway's 512 MB-ish per-
// container budget but big enough that we don't want to remove the cap
// without thinking. Callers that hit the cap get the truncated set
// with an X-Truncated header so the UI can warn the user.
const SCHEDULE_PDF_MAX_ROWS = 5000;

/* ===== HR/Ops list + CRUD =============================================== */

schedulingRouter.get('/shifts', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const clientId = req.query.clientId?.toString();
    const locationId = req.query.locationId?.toString();
    const from = req.query.from?.toString();
    const to = req.query.to?.toString();

    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      ...(status ? { status: status as Prisma.ShiftWhereInput['status'] } : {}),
      ...(clientId ? { clientId } : {}),
      // Narrow to one work-site within the client (cascading filter).
      ...(locationId ? { locationId } : {}),
      ...(from || to
        ? {
            startsAt: {
              ...(from ? { gte: new Date(from) } : {}),
              // Exclusive upper bound: the client sends the next period's start
              // (next midnight) as `to`. Using `lt` (not `lte`) keeps a shift
              // that starts exactly at that boundary in the NEXT period only,
              // instead of double-counting it in both adjacent windows.
              ...(to ? { lt: new Date(to) } : {}),
            },
          }
        : {}),
    };

    // Fetch one past the cap so we can tell the client the list was truncated
    // (more shifts match than we returned) without an extra count query.
    const SHIFT_PAGE_CAP = 200;
    const rows = await prisma.shift.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: SHIFT_PAGE_CAP + 1,
      include: SHIFT_INCLUDE,
    });
    const truncated = rows.length > SHIFT_PAGE_CAP;
    const payload = ShiftListResponseSchema.parse({
      shifts: rows.slice(0, SHIFT_PAGE_CAP).map(toShift),
      truncated,
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/kpis?from=ISO&to=ISO[&clientId=UUID]
 *
 * Phase 50 — top-of-page signal strip. Defaults to the current
 * Sunday→Saturday calendar week if from/to are missing. Returns:
 *   - openShifts        — count of OPEN status (unfilled, published)
 *   - assignedShifts    — count of ASSIGNED + COMPLETED
 *   - totalShifts       — non-cancelled count in the window
 *   - fillRatePercent   — assigned ÷ (assigned + open), 0-100
 *   - totalScheduledMinutes — sum of (endsAt - startsAt) for non-cancelled
 *
 * groupBy keeps this O(1 query) regardless of the window size.
 */
schedulingRouter.get('/kpis', MANAGE, async (req, res, next) => {
  try {
    const clientId = req.query.clientId?.toString();
    const fromParam = req.query.from?.toString();
    const toParam = req.query.to?.toString();
    const now = new Date();
    // Default window: Sunday 00:00 → next Sunday 00:00 (local time).
    const defaultFrom = new Date(now);
    defaultFrom.setHours(0, 0, 0, 0);
    defaultFrom.setDate(defaultFrom.getDate() - defaultFrom.getDay());
    const defaultTo = new Date(defaultFrom);
    defaultTo.setDate(defaultTo.getDate() + 7);
    const from = fromParam ? new Date(fromParam) : defaultFrom;
    const to = toParam ? new Date(toParam) : defaultTo;

    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      ...(clientId ? { clientId } : {}),
      startsAt: { gte: from, lt: to },
      status: { not: 'CANCELLED' },
    };

    const grouped = await prisma.shift.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });

    // For total scheduled minutes + projected labor cost we need the rows
    // (no SQL helper for computed durations in Prisma). Pull duration + the
    // two rate columns and roll up. Page through ALL matching rows in batches
    // — the old `take: 100` silently UNDER-reported minutes/cost for any week
    // with >100 shifts. Bounded by a batch backstop so a pathologically wide
    // window can't run unbounded.
    const ROLLUP_BATCH = 1000;
    const ROLLUP_MAX_BATCHES = 50; // 50k shifts — far beyond a real window
    let totalScheduledMinutes = 0;
    let projectedLaborCost = 0;
    let shiftsWithoutRate = 0;
    let cursor: string | undefined;
    for (let batchNo = 0; batchNo < ROLLUP_MAX_BATCHES; batchNo++) {
      const rows = await prisma.shift.findMany({
        where,
        select: { id: true, startsAt: true, endsAt: true, payRate: true },
        orderBy: { id: 'asc' },
        take: ROLLUP_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      for (const r of rows) {
        const minutes = Math.max(
          0,
          Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60_000),
        );
        totalScheduledMinutes += minutes;
        if (r.payRate === null) {
          shiftsWithoutRate += 1;
        } else {
          projectedLaborCost += (Number(r.payRate) * minutes) / 60;
        }
      }
      if (rows.length < ROLLUP_BATCH) break;
      cursor = rows[rows.length - 1]!.id;
    }
    // Round to cents — JSON floats survive 2dp safely; the UI formats as $.
    projectedLaborCost = Math.round(projectedLaborCost * 100) / 100;

    let openShifts = 0;
    let assignedShifts = 0;
    let draftShifts = 0;
    let completedShifts = 0;
    for (const g of grouped) {
      if (g.status === 'OPEN') openShifts = g._count._all;
      else if (g.status === 'ASSIGNED') assignedShifts = g._count._all;
      else if (g.status === 'DRAFT') draftShifts = g._count._all;
      else if (g.status === 'COMPLETED') completedShifts = g._count._all;
    }
    const filled = assignedShifts + completedShifts;
    const fillBase = filled + openShifts;
    const fillRatePercent = fillBase === 0 ? 0 : Math.round((filled / fillBase) * 100);

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      openShifts,
      assignedShifts,
      draftShifts,
      completedShifts,
      totalShifts: openShifts + assignedShifts + draftShifts + completedShifts,
      fillRatePercent,
      totalScheduledMinutes,
      projectedLaborCost,
      shiftsWithoutRate,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/associates
 *
 * Phase 53 — slim list of associates the caller is allowed to schedule
 * for. Drives the row axis of the pivot week view (rows=people × cols=days).
 * Gated to manage:scheduling, so only HR/Ops reach this endpoint.
 */
schedulingRouter.get('/associates', MANAGE, async (req, res, next) => {
  try {
    const clientId = req.query.clientId?.toString();
    const locationId = req.query.locationId?.toString();

    // Scope the roster to the selected work-site so the grid rows + the
    // create-dialog picker show only people who actually work there. An
    // associate "belongs" to a client/location via an APPROVED application
    // or an open assignment there. Falls back to the org-wide schedulable
    // set when nothing is selected.
    const userActive = { is: { status: 'ACTIVE', role: 'ASSOCIATE' } } as const;
    let where: Prisma.AssociateWhereInput;
    if (locationId) {
      where = {
        deletedAt: null,
        user: userActive,
        OR: [
          { applications: { some: { status: 'APPROVED', locationId } } },
          { assignments: { some: { endedAt: null, locationId } } },
        ],
      };
    } else if (clientId) {
      where = {
        deletedAt: null,
        user: userActive,
        OR: [
          { applications: { some: { status: 'APPROVED', clientId } } },
          { assignments: { some: { endedAt: null, location: { clientId } } } },
        ],
      };
    } else {
      where = ACTIVE_ASSOCIATE_FILTER;
    }

    const rows = await prisma.associate.findMany({
      where,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, email: true },
      take: 500,
    });
    res.json(AssociateListResponseSchema.parse({ associates: rows }));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/shifts', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;

    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');

    // Phase 131 — every Shift gets a Location. Use the explicit
    // locationId from the picker when provided; otherwise fall back
    // to the client's first active Location. The free-text `location`
    // field below stays for optional sub-zone labels ("Bar", "Patio",
    // "Floor 2 — Beauty").
    let location: { id: string };
    if (input.locationId) {
      const picked = await prisma.location.findFirst({
        where: { id: input.locationId, clientId: client.id, deletedAt: null, isActive: true },
        select: { id: true },
      });
      if (!picked) {
        throw new HttpError(
          400,
          'location_mismatch',
          'Location does not belong to the chosen client.',
        );
      }
      location = picked;
    } else {
      location = await firstLocationForClient(prisma, client.id);
    }

    const status = input.status ?? 'OPEN';
    const isPublishing = isPublishingTransition(undefined, status);
    const now = new Date();
    let lateNoticeReason: string | null = null;
    let publishedAt: Date | null = null;
    if (isPublishing) {
      const evaluation = evaluateShiftNotice({
        state: client.state,
        startsAt: new Date(input.startsAt),
        publishAt: now,
      });
      if (evaluation.requiresReason && !input.lateNoticeReason) {
        throw new HttpError(
          400,
          'late_notice_reason_required',
          `Publishing a shift inside the 14-day notice window in ${evaluation.state} requires lateNoticeReason`
        );
      }
      lateNoticeReason = input.lateNoticeReason ?? null;
      publishedAt = now;
    }

    const created = await prisma.shift.create({
      data: {
        clientId: input.clientId,
        locationId: location.id,
        position: input.position,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        location: input.location ?? null,
        hourlyRate: input.hourlyRate ?? null,
        payRate: input.payRate ?? null,
        notes: input.notes ?? null,
        status,
        createdById: req.user!.id,
        publishedAt,
        lateNoticeReason,
      },
      include: SHIFT_INCLUDE,
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.created',
      shiftId: created.id,
      clientId: created.clientId,
      metadata: {
        position: created.position,
        status: created.status,
        ...(lateNoticeReason ? { lateNoticeReason, lateNotice: true } : {}),
      },
      req,
    });

    res.status(201).json(toShift(created));
  } catch (err) {
    next(err);
  }
});

// Bulk create-and-assign — define one shift and stamp a copy onto many
// employees at once (each gets their own instance in their row), plus
// optional unassigned "open slot" copies. One transaction; employees who
// already have an overlapping shift are skipped and reported rather than
// double-booked.
schedulingRouter.post('/shifts/bulk', MANAGE, async (req, res, next) => {
  try {
    const parsed = BulkCreateShiftsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;

    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');

    // Resolve the work-site (explicit pick or the client's first Location).
    let location: { id: string; timezone: string };
    if (input.locationId) {
      const picked = await prisma.location.findFirst({
        where: { id: input.locationId, clientId: client.id, deletedAt: null, isActive: true },
        select: { id: true, timezone: true },
      });
      if (!picked) {
        throw new HttpError(
          400,
          'location_mismatch',
          'Location does not belong to the chosen client.',
        );
      }
      location = picked;
    } else {
      const first = await firstLocationForClient(prisma, client.id);
      const full = await prisma.location.findUniqueOrThrow({
        where: { id: first.id },
        select: { id: true, timezone: true },
      });
      location = full;
    }

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const status = input.status ?? 'OPEN';
    const isPublishing = isPublishingTransition(undefined, status);
    const now = new Date();
    let lateNoticeReason: string | null = null;
    let publishedAt: Date | null = null;
    if (isPublishing) {
      const evaluation = evaluateShiftNotice({
        state: client.state,
        startsAt,
        publishAt: now,
      });
      if (evaluation.requiresReason && !input.lateNoticeReason) {
        throw new HttpError(
          400,
          'late_notice_reason_required',
          `Publishing a shift inside the 14-day notice window in ${evaluation.state} requires lateNoticeReason`,
        );
      }
      lateNoticeReason = input.lateNoticeReason ?? null;
      publishedAt = now;
    }

    const associateIds = [...new Set(input.associateIds)];
    // Names for the skip report + notifications, and a validity check.
    const associates = await prisma.associate.findMany({
      where: { id: { in: associateIds }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    const nameById = new Map(
      associates.map((a) => [a.id, `${a.firstName} ${a.lastName}`]),
    );

    // Employees that don't resolve to a real associate are skipped up front;
    // the overlap conflict check happens INSIDE the transaction (below) so it
    // and the createMany are atomic — otherwise a concurrent assign between a
    // pre-check and the insert could slip a double-booking through.
    const candidateIds = associateIds.filter((id) => nameById.has(id));
    const notFoundSkips = associateIds
      .filter((id) => !nameById.has(id))
      .map((id) => ({ associateId: id, associateName: 'Unknown', reason: 'not_found' }));

    const baseData = {
      clientId: input.clientId,
      locationId: location.id,
      position: input.position,
      startsAt,
      endsAt,
      location: input.location ?? null,
      hourlyRate: input.hourlyRate ?? null,
      payRate: input.payRate ?? null,
      notes: input.notes ?? null,
      status,
      createdById: req.user!.id,
      publishedAt,
      lateNoticeReason,
    };
    const openCount = input.openCount ?? 0;

    // Conflict-check + create everything atomically.
    const { createdIds, toAssign, conflictedSkips } = await prisma.$transaction(
      async (tx) => {
        const conflictRows =
          candidateIds.length > 0
            ? await tx.shift.findMany({
                where: {
                  assignedAssociateId: { in: candidateIds },
                  status: { notIn: ['CANCELLED'] },
                  startsAt: { lt: endsAt },
                  endsAt: { gt: startsAt },
                },
                select: { assignedAssociateId: true },
              })
            : [];
        const conflicted = new Set(conflictRows.map((r) => r.assignedAssociateId));
        const toAssign = candidateIds.filter((id) => !conflicted.has(id));
        const conflictedSkips = candidateIds
          .filter((id) => conflicted.has(id))
          .map((id) => ({
            associateId: id,
            associateName: nameById.get(id)!,
            reason: 'already_scheduled',
          }));

        if (toAssign.length > 0) {
          await tx.shift.createMany({
            data: toAssign.map((associateId) => ({
              ...baseData,
              assignedAssociateId: associateId,
              assignedAt: now,
            })),
          });
        }
        if (openCount > 0) {
          await tx.shift.createMany({
            data: Array.from({ length: openCount }, () => ({ ...baseData })),
          });
        }
        // Pull the ids we just made (this manager, this exact window +
        // position) so the audit log references them.
        const rows = await tx.shift.findMany({
          where: {
            createdById: req.user!.id,
            clientId: input.clientId,
            locationId: location.id,
            position: input.position,
            startsAt,
            endsAt,
            createdAt: { gte: now },
          },
          select: { id: true },
        });
        return { createdIds: rows.map((r) => r.id), toAssign, conflictedSkips };
      },
      // This transaction does a conflict scan + up to two createMany + an id
      // fetch; the default 5s interactive-transaction window is tight for a
      // large bulk on a cold pool, so give it room.
      { timeout: 20_000 },
    );

    const skipped = [...notFoundSkips, ...conflictedSkips];
    const createdCount = toAssign.length + openCount;
    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.bulk_created',
      shiftId: createdIds[0] ?? 'bulk',
      clientId: input.clientId,
      metadata: {
        position: input.position,
        status,
        assigned: toAssign.length,
        openSlots: openCount,
        skipped: skipped.length,
        ...(lateNoticeReason ? { lateNoticeReason, lateNotice: true } : {}),
      },
      req,
    });

    // Notify each assigned associate only if the shift is already published
    // (drafts stay private until the week is published).
    if (publishedAt) {
      const line = formatShiftLine({
        position: input.position,
        clientName: client.name,
        startsAt,
        endsAt,
        timezone: location.timezone,
      });
      for (const associateId of toAssign) {
        await notifyShift(prisma, {
          associateId,
          subject: 'New shift',
          body: `You've been assigned: ${line}`,
          category: 'shift_assigned',
          senderUserId: req.user!.id,
        });
      }
    }

    const payload: BulkCreateShiftsResponse = { created: createdCount, skipped };
    res.status(201).json(BulkCreateShiftsResponseSchema.parse(payload));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.patch('/shifts/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }

    const existing = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
      include: { client: { select: { state: true } } },
    });
    if (!existing) throw new HttpError(404, 'shift_not_found', 'Shift not found');

    // A finished or cancelled shift is a historical record — block edits so
    // its times/status can't drift after the fact (an analytics query that
    // re-derives hours from startsAt/endsAt would otherwise read wrong).
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw new HttpError(
        409,
        'shift_not_editable',
        `A ${existing.status.toLowerCase()} shift can't be edited. Delete it instead, or create a new one.`,
      );
    }

    const data: Prisma.ShiftUpdateInput = {};
    const i = parsed.data;
    if (i.position !== undefined) data.position = i.position;
    if (i.startsAt !== undefined) data.startsAt = new Date(i.startsAt);
    if (i.endsAt !== undefined) data.endsAt = new Date(i.endsAt);
    if (i.location !== undefined) data.location = i.location;
    if (i.hourlyRate !== undefined) data.hourlyRate = i.hourlyRate;
    if (i.payRate !== undefined) data.payRate = i.payRate;
    if (i.notes !== undefined) data.notes = i.notes;
    if (i.status !== undefined) data.status = i.status;

    // Phase 25 — predictive scheduling enforcement on a DRAFT→OPEN/ASSIGNED
    // transition. Re-publishing or other status changes don't re-evaluate.
    if (i.status !== undefined && isPublishingTransition(existing.status, i.status)) {
      const now = new Date();
      const newStartsAt = i.startsAt ? new Date(i.startsAt) : existing.startsAt;
      const evaluation = evaluateShiftNotice({
        state: existing.client.state,
        startsAt: newStartsAt,
        publishAt: now,
      });
      if (evaluation.requiresReason && !i.lateNoticeReason) {
        throw new HttpError(
          400,
          'late_notice_reason_required',
          `Publishing a shift inside the 14-day notice window in ${evaluation.state} requires lateNoticeReason`
        );
      }
      data.publishedAt = now;
      data.lateNoticeReason = i.lateNoticeReason ?? null;
    } else if (
      i.startsAt !== undefined &&
      i.status === undefined &&
      existing.publishedAt &&
      existing.status !== 'DRAFT'
    ) {
      // Already-published shift whose START is being moved (no status
      // change). Pulling it earlier could drag it inside the 14-day notice
      // window — re-evaluate so this path can't bypass fair-workweek.
      const evaluation = evaluateShiftNotice({
        state: existing.client.state,
        startsAt: new Date(i.startsAt),
        publishAt: new Date(),
      });
      if (evaluation.requiresReason && !i.lateNoticeReason) {
        throw new HttpError(
          400,
          'late_notice_reason_required',
          `Moving a published shift inside the 14-day notice window in ${evaluation.state} requires lateNoticeReason`,
        );
      }
      if (i.lateNoticeReason) data.lateNoticeReason = i.lateNoticeReason;
    }

    // Un-publish: moving a published shift back to DRAFT makes it private
    // again — clear the publish stamp + late-notice reason so a later
    // re-publish re-evaluates the fair-workweek notice window fresh.
    if (i.status === 'DRAFT' && existing.status !== 'DRAFT') {
      data.publishedAt = null;
      data.lateNoticeReason = null;
    }

    // June audit P0: editing an assigned shift's times (or promoting it to
    // ASSIGNED) had no double-booking guard — moving a shift onto another
    // of the same associate's shifts silently double-booked them. Check
    // inside the same transaction as the write so a concurrent /assign
    // can't slip in between.
    const timesChanged = i.startsAt !== undefined || i.endsAt !== undefined;
    const assigneeAfter =
      existing.assignedAssociateId && (i.status ?? existing.status) === 'ASSIGNED'
        ? existing.assignedAssociateId
        : null;
    const newStarts = i.startsAt ? new Date(i.startsAt) : existing.startsAt;
    const newEnds = i.endsAt ? new Date(i.endsAt) : existing.endsAt;

    const updated = await prisma.$transaction(async (tx) => {
      if (assigneeAfter && (timesChanged || i.status === 'ASSIGNED')) {
        if (
          await associateHasOverlap(tx, assigneeAfter, newStarts, newEnds, existing.id)
        ) {
          throw new HttpError(
            409,
            'associate_double_booked',
            'These times overlap another shift already assigned to this associate.',
          );
        }
      }
      return tx.shift.update({
        where: { id: existing.id },
        data,
        include: SHIFT_INCLUDE,
      });
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.updated',
      shiftId: updated.id,
      clientId: updated.clientId,
      metadata: {
        fields: Object.keys(data),
        ...(updated.lateNoticeReason && data.publishedAt
          ? { lateNoticeReason: updated.lateNoticeReason, lateNotice: true }
          : {}),
      },
      req,
    });

    // Notify the assignee on a DRAFT→OPEN/ASSIGNED publish transition.
    // We don't notify on every PATCH — that would spam associates with
    // "your shift was edited" for trivial location/notes tweaks.
    if (data.publishedAt && updated.assignedAssociateId) {
      await notifyShift(prisma, {
        associateId: updated.assignedAssociateId,
        subject: 'Shift published',
        body: `Now on your schedule: ${formatShiftLine({
          position: updated.position,
          clientName: updated.client?.name ?? null,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          timezone: updated.locationRel?.timezone ?? null,
        })}`,
        category: 'shift_published',
        senderUserId: req.user!.id,
      });
    }

    res.json(toShift(updated));
  } catch (err) {
    next(err);
  }
});

// Hard delete — removes the shift outright (vs. cancel, which keeps a
// CANCELLED record). Intended for cleaning up drafts and mistaken shifts.
// Cascades to the shift's swap requests, qualification requirements, and
// open-shift claims (all onDelete: Cascade). The confirm lives client-side;
// the audit log keeps the trail even though the row is gone.
schedulingRouter.delete('/shifts/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
      select: {
        id: true,
        clientId: true,
        position: true,
        status: true,
        assignedAssociateId: true,
      },
    });
    if (!existing) throw new HttpError(404, 'shift_not_found', 'Shift not found');

    await prisma.shift.delete({ where: { id: existing.id } });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.deleted',
      shiftId: existing.id,
      clientId: existing.clientId,
      metadata: {
        position: existing.position,
        status: existing.status,
        wasAssigned: existing.assignedAssociateId !== null,
      },
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Assignment ======================================================= */

schedulingRouter.post('/shifts/:id/assign', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftAssignInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }

    const shift = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
    });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (shift.status === 'CANCELLED') {
      throw new HttpError(409, 'shift_cancelled', 'Cannot assign a cancelled shift');
    }
    if (shift.status === 'COMPLETED') {
      throw new HttpError(409, 'shift_completed', 'Cannot assign a completed shift');
    }

    const associate = await prisma.associate.findFirst({
      where: { id: parsed.data.associateId, deletedAt: null },
    });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');

    // Conflict check + write in one transaction so two managers can't
    // assign the same associate to overlapping shifts at the same instant.
    const updated = await prisma.$transaction(async (tx) => {
      if (
        await associateHasOverlap(
          tx,
          associate.id,
          shift.startsAt,
          shift.endsAt,
          shift.id,
        )
      ) {
        throw new HttpError(
          409,
          'associate_double_booked',
          `${associate.firstName} ${associate.lastName} already has an overlapping shift.`,
        );
      }
      return tx.shift.update({
        where: { id: shift.id },
        data: {
          assignedAssociateId: associate.id,
          assignedAt: new Date(),
          status: 'ASSIGNED',
        },
        include: SHIFT_INCLUDE,
      });
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.assigned',
      shiftId: updated.id,
      clientId: updated.clientId,
      metadata: { associateId: associate.id },
      req,
    });

    // Only notify if the shift is already published — otherwise the
    // manager is pre-assigning a draft that the associate isn't supposed
    // to see yet. The publish PATCH route will fire its own notification
    // when the schedule actually goes out.
    if (updated.publishedAt) {
      await notifyShift(prisma, {
        associateId: associate.id,
        subject: 'New shift assigned',
        body: `You've been assigned: ${formatShiftLine({
          position: updated.position,
          clientName: updated.client?.name ?? null,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          timezone: updated.locationRel?.timezone ?? null,
        })}`,
        category: 'shift_assigned',
        senderUserId: req.user!.id,
      });
    }

    res.json(toShift(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/shifts/:id/unassign', MANAGE, async (req, res, next) => {
  try {
    const shift = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
    });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (!shift.assignedAssociateId) {
      throw new HttpError(409, 'not_assigned', 'Shift is not currently assigned');
    }

    const previousAssociateId = shift.assignedAssociateId;
    const updated = await prisma.shift.update({
      where: { id: shift.id },
      data: {
        assignedAssociateId: null,
        assignedAt: null,
        status: shift.status === 'ASSIGNED' ? 'OPEN' : shift.status,
      },
      include: SHIFT_INCLUDE,
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.unassigned',
      shiftId: updated.id,
      clientId: updated.clientId,
      metadata: { previousAssociateId },
      req,
    });

    // Only notify if the shift was visible to the associate. Removing
    // someone from a draft shift is invisible — they never knew they were
    // on it.
    if (shift.publishedAt) {
      await notifyShift(prisma, {
        associateId: previousAssociateId,
        subject: 'Shift removed from your schedule',
        body: `Removed: ${formatShiftLine({
          position: updated.position,
          clientName: updated.client?.name ?? null,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          timezone: updated.locationRel?.timezone ?? null,
        })}`,
        category: 'shift_unassigned',
        senderUserId: req.user!.id,
      });
    }

    res.json(toShift(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/shifts/:id/cancel', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftCancelInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const shift = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
    });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (shift.status === 'COMPLETED') {
      throw new HttpError(409, 'shift_completed', 'Cannot cancel a completed shift');
    }

    const updated = await prisma.shift.update({
      where: { id: shift.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: parsed.data.reason,
      },
      include: SHIFT_INCLUDE,
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.cancelled',
      shiftId: updated.id,
      clientId: updated.clientId,
      metadata: { reason: parsed.data.reason },
      req,
    });

    // Cancel any in-flight swap requests for this shift — there's nothing
    // left to swap. Otherwise a PENDING_PEER/PEER_ACCEPTED swap sits in the
    // queue forever and the counterparty could still "accept" a dead shift.
    const liveSwaps = await prisma.shiftSwapRequest.findMany({
      where: {
        shiftId: shift.id,
        status: { in: ['PENDING_PEER', 'PEER_ACCEPTED'] },
      },
      select: {
        id: true,
        requesterAssociateId: true,
        counterpartyAssociateId: true,
      },
    });
    if (liveSwaps.length > 0) {
      await prisma.shiftSwapRequest.updateMany({
        where: { id: { in: liveSwaps.map((s) => s.id) } },
        data: { status: 'CANCELLED' },
      });
      const swapLine = formatShiftLine({
        position: updated.position,
        clientName: updated.client?.name ?? null,
        startsAt: updated.startsAt,
        endsAt: updated.endsAt,
        timezone: updated.locationRel?.timezone ?? null,
      });
      const notified = new Set<string>();
      for (const sw of liveSwaps) {
        for (const aid of [sw.requesterAssociateId, sw.counterpartyAssociateId]) {
          if (aid && !notified.has(aid)) {
            notified.add(aid);
            await notifyShift(prisma, {
              associateId: aid,
              subject: 'Swap cancelled',
              body: `A swap you were part of is off — the shift was cancelled. ${swapLine}`,
              category: 'swap_manager_rejected',
              senderUserId: req.user!.id,
            });
          }
        }
      }
    }

    // Same draft rule as unassign — cancelling a never-published shift
    // is invisible to the associate, so no notification.
    if (shift.assignedAssociateId && shift.publishedAt) {
      await notifyShift(prisma, {
        associateId: shift.assignedAssociateId,
        subject: 'Shift cancelled',
        body: `Cancelled: ${formatShiftLine({
          position: updated.position,
          clientName: updated.client?.name ?? null,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          timezone: updated.locationRel?.timezone ?? null,
        })}\nReason: ${parsed.data.reason}`,
        category: 'shift_cancelled',
        senderUserId: req.user!.id,
      });
    }

    res.json(toShift(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== Associate-facing /me ============================================ */

const MY_SHIFTS_CAP = 100;

/**
 * The admin `toShift` payload minus the money fields. `hourlyRate` is the
 * CLIENT BILL rate (revenue side) — paired with `payRate` it exposes the
 * staffing margin, so neither belongs in an associate-facing response.
 * Nulled rather than omitted so the shared ShiftSchema still parses.
 */
function toAssociateShift(row: Parameters<typeof toShift>[0]): Shift {
  return { ...toShift(row), hourlyRate: null, payRate: null };
}

schedulingRouter.get('/me/shifts', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      const empty: ShiftListResponse = { shifts: [] };
      res.json(empty);
      return;
    }
    // Bound the past so the `take` cap can't be exhausted by months of
    // history and push a long-tenured associate's UPCOMING shifts off the
    // end. 30 days back keeps recent worked shifts visible (the app's "My
    // schedule" splits these into a Recent section) while guaranteeing all
    // future shifts fit; the calendar feed has its own wider window.
    const pastHorizon = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.shift.findMany({
      where: {
        assignedAssociateId: user.associateId,
        // Associates only see published shifts. `publishedAt` is stamped
        // the first time a shift transitions out of DRAFT, so a non-null
        // value is the canonical "the manager has shown this to people"
        // signal — matches Sling/Deputy/7shifts conventions and keeps the
        // schedule editable in draft form without leaking to associates.
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
        startsAt: { gte: pastHorizon },
      },
      orderBy: { startsAt: 'asc' },
      // Over-fetch one row so truncation is detectable — ascending order
      // means the FURTHEST-FUTURE shifts are the ones that fall off, which
      // must never read as "no more shifts".
      take: MY_SHIFTS_CAP + 1,
      include: SHIFT_INCLUDE,
    });
    const truncated = rows.length > MY_SHIFTS_CAP;
    res.json({
      shifts: rows.slice(0, MY_SHIFTS_CAP).map(toAssociateShift),
      truncated,
    } satisfies ShiftListResponse);
  } catch (err) {
    next(err);
  }
});

const HISTORY_PAGE = 50;

/**
 * GET /scheduling/me/shifts/history?before=<ISO>
 *
 * Older published shifts, newest-first, 50 a page. `before` defaults to the
 * main list's 30-day horizon so the first page picks up exactly where the
 * Recent section ends. Registered BEFORE /me/shifts/:id so the literal
 * "history" segment isn't swallowed as an id.
 */
schedulingRouter.get('/me/shifts/history', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(MyShiftHistoryResponseSchema.parse({ shifts: [], nextBefore: null }));
      return;
    }
    const raw = req.query.before?.toString();
    const parsed = raw ? new Date(raw) : null;
    if (raw && Number.isNaN(parsed!.getTime())) {
      throw new HttpError(400, 'invalid_before', '`before` must be an ISO datetime');
    }
    const before =
      parsed ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.shift.findMany({
      where: {
        assignedAssociateId: user.associateId,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
        startsAt: { lt: before },
      },
      orderBy: { startsAt: 'desc' },
      take: HISTORY_PAGE + 1,
      include: SHIFT_INCLUDE,
    });
    const page = rows.slice(0, HISTORY_PAGE);
    res.json(
      MyShiftHistoryResponseSchema.parse({
        shifts: page.map(toAssociateShift),
        nextBefore:
          rows.length > HISTORY_PAGE
            ? page[page.length - 1]!.startsAt.toISOString()
            : null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/me/shifts/:id
 *
 * Detail for ONE of the caller's own published shifts, plus everyone whose
 * published shift overlaps it at the same work site — the "who am I working
 * with" panel (Sling-style). Teammates scope to the same location when the
 * shift has one, otherwise the same client, and expose only name/position/
 * times/sub-zone (names are already associate-visible via /directory).
 */
schedulingRouter.get('/me/shifts/:id', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }
    const shift = await prisma.shift.findFirst({
      where: {
        id: req.params.id,
        assignedAssociateId: user.associateId,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
      },
      include: SHIFT_INCLUDE,
    });
    // Same 404 whether the shift doesn't exist or belongs to someone else —
    // don't confirm foreign shift ids to a probing client.
    if (!shift) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }

    const overlapping = await prisma.shift.findMany({
      where: {
        id: { not: shift.id },
        clientId: shift.clientId,
        ...(shift.locationId ? { locationId: shift.locationId } : {}),
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
        AND: [
          { assignedAssociateId: { not: null } },
          { assignedAssociateId: { not: user.associateId } },
        ],
        startsAt: { lt: shift.endsAt },
        endsAt: { gt: shift.startsAt },
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
      include: { assignedAssociate: { select: { firstName: true, lastName: true } } },
    });
    // One row per person — back-to-back split shifts would otherwise list
    // the same teammate twice.
    const seen = new Set<string>();
    const teammates = overlapping.flatMap((s) => {
      if (!s.assignedAssociateId || !s.assignedAssociate || seen.has(s.assignedAssociateId)) {
        return [];
      }
      seen.add(s.assignedAssociateId);
      return [
        {
          associateId: s.assignedAssociateId,
          name: `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}`,
          position: s.position,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          location: s.location,
        },
      ];
    });

    res.json(
      MyShiftDetailResponseSchema.parse({
        shift: toAssociateShift(shift),
        teammates,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/me/shifts/:id/swap-candidates
 *
 * Who the caller can offer this shift to: the schedulable pool (ACTIVE
 * ASSOCIATE-role, onboarded) minus themselves, each flagged `busy` when
 * they already have a shift overlapping this one. Advisory — the swap
 * POST and manager approval remain the enforcement points.
 */
schedulingRouter.get('/me/shifts/:id/swap-candidates', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }
    const shift = await prisma.shift.findFirst({
      where: {
        id: req.params.id,
        assignedAssociateId: user.associateId,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
      },
      select: {
        id: true,
        clientId: true,
        startsAt: true,
        endsAt: true,
        locationRel: { select: { timezone: true } },
      },
    });
    if (!shift) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }

    // Schedulable pool ∩ placed at THIS client — offering a Publix shift
    // to someone who has never worked Publix is a dead-on-arrival request.
    // AND-composed because ACTIVE_ASSOCIATE_FILTER carries its own OR;
    // spreading a second OR key would silently overwrite the first.
    const pool = await prisma.associate.findMany({
      where: {
        AND: [
          ACTIVE_ASSOCIATE_FILTER,
          { id: { not: user.associateId } },
          {
            OR: [
              { applications: { some: { clientId: shift.clientId, status: 'APPROVED' } } },
              {
                assignments: {
                  some: { endedAt: null, location: { is: { clientId: shift.clientId } } },
                },
              },
            ],
          },
        ],
      },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 200,
    });
    const poolIds = pool.map((a) => a.id);
    const [clashes, dayBlocked] = await Promise.all([
      prisma.shift.findMany({
        where: {
          id: { not: shift.id },
          assignedAssociateId: { in: poolIds },
          status: { notIn: ['CANCELLED'] },
          startsAt: { lt: shift.endsAt },
          endsAt: { gt: shift.startsAt },
        },
        select: { assignedAssociateId: true },
      }),
      // Approved time off + one-off days off count as busy too — a request
      // to someone on vacation dies at manager review anyway.
      blockedForWindow(
        poolIds,
        shift.startsAt,
        shift.endsAt,
        shift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
      ),
    ]);
    const busyIds = new Set([
      ...clashes.map((c) => c.assignedAssociateId as string),
      ...dayBlocked,
    ]);

    res.json(
      SwapCandidateListResponseSchema.parse({
        candidates: pool.map((a) => ({
          associateId: a.id,
          name: `${a.firstName} ${a.lastName}`,
          busy: busyIds.has(a.id),
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/me/calendar-url
 *
 * Returns the personal iCal subscription URL for the signed-in associate.
 * Token is HMAC-derived (deterministic per CALENDAR_FEED_SECRET +
 * associateId), so successive calls return the same URL — calendar
 * clients can subscribe once and keep getting updates.
 *
 * The webcal:// variant triggers Apple Calendar's subscribe handler on
 * macOS/iOS without an extra step; the https:// URL works for Google
 * Calendar's "Add by URL" flow and Outlook.
 */
/**
 * POST /scheduling/me/shifts/:id/acknowledge
 *
 * "I'll be there." Idempotent — the guarded update only stamps the first
 * tap, and re-acknowledging returns the shift unchanged. Admins see
 * acknowledgedAt on every shift payload and can chase the silent ones.
 */
schedulingRouter.post('/me/shifts/:id/acknowledge', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'shift_not_found', 'Shift not found');
    }
    const owned = await prisma.shift.findFirst({
      where: {
        id: req.params.id,
        assignedAssociateId: user.associateId,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
      },
      select: { id: true },
    });
    if (!owned) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    await prisma.shift.updateMany({
      where: { id: owned.id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date() },
    });
    const fresh = await prisma.shift.findUniqueOrThrow({
      where: { id: owned.id },
      include: SHIFT_INCLUDE,
    });
    res.json(toAssociateShift(fresh));
  } catch (err) {
    next(err);
  }
});

/* ===== One-off availability exceptions ("can't work July 15") ========== */

const exceptionDayString = (d: Date) => d.toISOString().slice(0, 10);

schedulingRouter.get('/me/availability/exceptions', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(AvailabilityExceptionListResponseSchema.parse({ exceptions: [] }));
      return;
    }
    // From yesterday forward — past exceptions are noise in the editor.
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await prisma.availabilityException.findMany({
      where: { associateId: user.associateId, date: { gte: from } },
      orderBy: { date: 'asc' },
      take: 100,
    });
    res.json(
      AvailabilityExceptionListResponseSchema.parse({
        exceptions: rows.map((r) => ({
          id: r.id,
          date: exceptionDayString(r.date),
          note: r.note,
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/me/availability/exceptions', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates set availability');
    }
    const parsed = AvailabilityExceptionCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const date = new Date(`${parsed.data.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
      throw new HttpError(400, 'invalid_date', 'Invalid date');
    }
    // Upsert on the (associateId, date) unique key — re-adding the same
    // day just refreshes the note instead of erroring.
    const row = await prisma.availabilityException.upsert({
      where: { associateId_date: { associateId: user.associateId, date } },
      create: {
        associateId: user.associateId,
        date,
        note: parsed.data.note?.trim() || null,
      },
      update: { note: parsed.data.note?.trim() || null },
    });
    res.status(201).json({
      id: row.id,
      date: exceptionDayString(row.date),
      note: row.note,
    });
  } catch (err) {
    next(err);
  }
});

schedulingRouter.delete('/me/availability/exceptions/:id', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
    const gone = await prisma.availabilityException.deleteMany({
      where: { id: req.params.id, associateId: user.associateId },
    });
    if (gone.count === 0) throw new HttpError(404, 'not_found', 'Not found');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Open-shift pickup (Phase 85 claims, finally wired) =============== */

/** ClientIds where the associate is placed — approved application or an
 *  open assignment. Open shifts outside these clients aren't offered. */
async function placedClientIds(associateId: string): Promise<string[]> {
  const [apps, assignments] = await Promise.all([
    prisma.application.findMany({
      where: { associateId, status: 'APPROVED' },
      select: { clientId: true },
    }),
    prisma.associateAssignment.findMany({
      where: { associateId, endedAt: null },
      select: { location: { select: { clientId: true } } },
    }),
  ]);
  return Array.from(
    new Set([
      ...apps.map((a) => a.clientId),
      ...assignments.map((a) => a.location.clientId),
    ]),
  );
}

schedulingRouter.get('/me/open-shifts', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(OpenShiftsResponseSchema.parse({ shifts: [] }));
      return;
    }
    const clientIds = await placedClientIds(user.associateId);
    if (clientIds.length === 0) {
      res.json(OpenShiftsResponseSchema.parse({ shifts: [] }));
      return;
    }
    const rows = await prisma.shift.findMany({
      where: {
        clientId: { in: clientIds },
        status: 'OPEN',
        assignedAssociateId: null,
        publishedAt: { not: null },
        startsAt: { gt: new Date() },
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
      include: SHIFT_INCLUDE,
    });

    // Hide shifts the associate couldn't actually take: overlapping their
    // own schedule, or on a day they're off (PTO / exception). Cheaper to
    // over-fetch 50 and filter than to hide the section's real emptiness.
    const mine = await prisma.shift.findMany({
      where: {
        assignedAssociateId: user.associateId,
        status: { notIn: ['CANCELLED'] },
        endsAt: { gt: new Date() },
      },
      select: { startsAt: true, endsAt: true },
    });
    const eligible: typeof rows = [];
    for (const s of rows) {
      const overlaps = mine.some(
        (m) => m.startsAt < s.endsAt && m.endsAt > s.startsAt,
      );
      if (overlaps) continue;
      const tz = s.locationRel?.timezone ?? DEFAULT_TIMEZONE;
      const blocked = await blockedForWindow(
        [user.associateId],
        s.startsAt,
        s.endsAt,
        tz,
      );
      if (blocked.size > 0) continue;
      eligible.push(s);
    }

    const claims = await prisma.openShiftClaim.findMany({
      where: {
        associateId: user.associateId,
        shiftId: { in: eligible.map((s) => s.id) },
        status: 'PENDING',
      },
      select: { id: true, shiftId: true, status: true },
    });
    const claimByShift = new Map(claims.map((c) => [c.shiftId, c]));

    res.json(
      OpenShiftsResponseSchema.parse({
        shifts: eligible.map((s) => ({
          ...toAssociateShift(s),
          myClaimStatus: claimByShift.get(s.id)?.status ?? null,
          myClaimId: claimByShift.get(s.id)?.id ?? null,
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/me/open-shifts/:id/claim', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can pick up shifts');
    }
    const shift = await prisma.shift.findFirst({
      where: {
        id: req.params.id,
        status: 'OPEN',
        assignedAssociateId: null,
        publishedAt: { not: null },
        startsAt: { gt: new Date() },
      },
      include: SHIFT_INCLUDE,
    });
    if (!shift) {
      throw new HttpError(404, 'shift_not_available', 'This shift is no longer open');
    }
    const clientIds = await placedClientIds(user.associateId);
    if (!clientIds.includes(shift.clientId)) {
      throw new HttpError(403, 'not_placed_at_client', 'You are not placed at this client');
    }
    if (
      await associateHasOverlap(prisma, user.associateId, shift.startsAt, shift.endsAt, shift.id)
    ) {
      throw new HttpError(409, 'overlaps_your_schedule', 'This shift overlaps one of yours');
    }
    const tz = shift.locationRel?.timezone ?? DEFAULT_TIMEZONE;
    const blocked = await blockedForWindow([user.associateId], shift.startsAt, shift.endsAt, tz);
    if (blocked.size > 0) {
      throw new HttpError(409, 'day_unavailable', 'You have time off or a day off then');
    }
    const existing = await prisma.openShiftClaim.findFirst({
      where: { shiftId: shift.id, associateId: user.associateId, status: 'PENDING' },
      select: { id: true },
    });
    if (existing) {
      throw new HttpError(409, 'already_requested', 'You already requested this shift');
    }

    const claim = await prisma.openShiftClaim.create({
      data: { shiftId: shift.id, associateId: user.associateId, status: 'PENDING' },
    });
    await recordShiftEvent({
      actorUserId: user.id,
      action: 'shift.pickup_requested',
      shiftId: shift.id,
      clientId: shift.clientId,
      metadata: { associateId: user.associateId, claimId: claim.id },
      req,
    });
    const me = await prisma.associate.findUnique({
      where: { id: user.associateId },
      select: { firstName: true, lastName: true },
    });
    void notifyAllAdmins({
      subject: 'Open-shift pickup request',
      body: `${me?.firstName ?? 'An associate'} ${me?.lastName ?? ''} wants to pick up: ${formatShiftLine({
        position: shift.position,
        clientName: shift.client?.name ?? null,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        timezone: tz,
      })}\nApprove or reject it from the Scheduling page.`,
      category: 'scheduling',
      excludeUserId: user.id,
    });

    res.status(201).json(
      OpenShiftClaimSchema.parse({
        id: claim.id,
        shiftId: claim.shiftId,
        status: claim.status,
        createdAt: claim.createdAt.toISOString(),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/me/open-shift-claims/:id/withdraw', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) throw new HttpError(404, 'not_found', 'Not found');
    // Guarded transition: only a still-PENDING claim of mine can withdraw.
    const cas = await prisma.openShiftClaim.updateMany({
      where: { id: req.params.id, associateId: user.associateId, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'not_pending', 'This request was already decided');
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const CLAIM_INCLUDE = {
  associate: { select: { firstName: true, lastName: true } },
  shift: {
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  },
} as const;

schedulingRouter.get('/open-shift-claims', MANAGE, async (req, res, next) => {
  try {
    const rows = await prisma.openShiftClaim.findMany({
      where: { status: 'PENDING', shift: { is: scopeShifts(req.user!) } },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: CLAIM_INCLUDE,
    });
    res.json(
      AdminOpenShiftClaimListResponseSchema.parse({
        claims: rows.map((c) => ({
          id: c.id,
          status: c.status,
          associateId: c.associateId,
          associateName: `${c.associate.firstName} ${c.associate.lastName}`,
          shiftId: c.shiftId,
          shiftPosition: c.shift.position,
          shiftClientName: c.shift.client?.name ?? null,
          shiftStartsAt: c.shift.startsAt.toISOString(),
          shiftEndsAt: c.shift.endsAt.toISOString(),
          shiftTimezone: c.shift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
          createdAt: c.createdAt.toISOString(),
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/open-shift-claims/:id/approve', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const claim = await prisma.openShiftClaim.findFirst({
      where: { id: req.params.id, shift: { is: scopeShifts(req.user!) } },
      include: CLAIM_INCLUDE,
    });
    if (!claim) throw new HttpError(404, 'claim_not_found', 'Pickup request not found');
    if (claim.status !== 'PENDING') {
      throw new HttpError(409, 'not_pending', `Request is ${claim.status}`);
    }

    // Atomic: CAS the claim, guarded-claim the shift (it must STILL be
    // open+unassigned — mirrors the auto-scheduler's TOCTOU guard), verify
    // the associate didn't get double-booked since requesting.
    await prisma.$transaction(async (tx) => {
      const cas = await tx.openShiftClaim.updateMany({
        where: { id: claim.id, status: 'PENDING' },
        data: { status: 'APPROVED', decidedById: user.id, decidedAt: new Date() },
      });
      if (cas.count === 0) {
        throw new HttpError(409, 'not_pending', 'Request was already decided');
      }
      if (
        await associateHasOverlap(
          tx,
          claim.associateId,
          claim.shift.startsAt,
          claim.shift.endsAt,
          claim.shiftId,
        )
      ) {
        throw new HttpError(
          409,
          'associate_double_booked',
          'They picked up another overlapping shift in the meantime',
        );
      }
      const took = await tx.shift.updateMany({
        where: { id: claim.shiftId, status: 'OPEN', assignedAssociateId: null },
        data: {
          status: 'ASSIGNED',
          assignedAssociateId: claim.associateId,
          assignedAt: new Date(),
        },
      });
      if (took.count === 0) {
        throw new HttpError(409, 'shift_gone', 'Shift was filled or changed already');
      }
      // Everyone else waiting on this shift loses automatically.
      await tx.openShiftClaim.updateMany({
        where: { shiftId: claim.shiftId, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          decidedById: user.id,
          decidedAt: new Date(),
          decisionNote: 'Shift was filled',
        },
      });
    });

    await recordShiftEvent({
      actorUserId: user.id,
      action: 'shift.pickup_approved',
      shiftId: claim.shiftId,
      clientId: claim.shift.clientId,
      metadata: { associateId: claim.associateId, claimId: claim.id },
      req,
    });
    const line = formatShiftLine({
      position: claim.shift.position,
      clientName: claim.shift.client?.name ?? null,
      startsAt: claim.shift.startsAt,
      endsAt: claim.shift.endsAt,
      timezone: claim.shift.locationRel?.timezone ?? null,
    });
    await notifyShift(prisma, {
      associateId: claim.associateId,
      subject: 'Pickup approved — shift is yours',
      body: `You're on: ${line}`,
      category: 'shift_pickup_approved',
      senderUserId: user.id,
    });
    // Notify the associates whose pending requests just auto-lost.
    const losers = await prisma.openShiftClaim.findMany({
      where: {
        shiftId: claim.shiftId,
        status: 'REJECTED',
        decisionNote: 'Shift was filled',
        decidedAt: { gte: new Date(Date.now() - 60_000) },
        NOT: { associateId: claim.associateId },
      },
      select: { associateId: true },
      distinct: ['associateId'],
    });
    for (const l of losers) {
      await notifyShift(prisma, {
        associateId: l.associateId,
        subject: 'Open shift filled',
        body: `That open shift went to someone else: ${line}`,
        category: 'shift_pickup_rejected',
        senderUserId: user.id,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/open-shift-claims/:id/reject', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const claim = await prisma.openShiftClaim.findFirst({
      where: { id: req.params.id, shift: { is: scopeShifts(req.user!) } },
      include: CLAIM_INCLUDE,
    });
    if (!claim) throw new HttpError(404, 'claim_not_found', 'Pickup request not found');
    const cas = await prisma.openShiftClaim.updateMany({
      where: { id: claim.id, status: 'PENDING' },
      data: { status: 'REJECTED', decidedById: user.id, decidedAt: new Date() },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'not_pending', `Request is ${claim.status}`);
    }
    await notifyShift(prisma, {
      associateId: claim.associateId,
      subject: 'Pickup request declined',
      body: `Your pickup request wasn't approved: ${formatShiftLine({
        position: claim.shift.position,
        clientName: claim.shift.client?.name ?? null,
        startsAt: claim.shift.startsAt,
        endsAt: claim.shift.endsAt,
        timezone: claim.shift.locationRel?.timezone ?? null,
      })}`,
      category: 'shift_pickup_rejected',
      senderUserId: user.id,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function buildCalendarFeedUrls(associateId: string, version: number) {
  const token = mintCalendarToken(associateId, version);
  // APP_BASE_URL is the web app origin in dev; in prod the API and SPA
  // share an origin (Railway single-service setup), so this works for
  // both. The `/api/calendar/v1/...` prefix matches the prod proxy path
  // — in dev the SPA proxies `/api/*` to the API.
  const base = env.APP_BASE_URL.replace(/\/$/, '');
  const url = `${base}/api/calendar/v1/${associateId}/${token}.ics`;
  const webcalUrl = url.replace(/^https?:\/\//, 'webcal://');
  return CalendarFeedUrlResponseSchema.parse({ url, webcalUrl });
}

schedulingRouter.get('/me/calendar-url', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'no_associate', 'No associate profile linked');
    }
    const associate = await prisma.associate.findUnique({
      where: { id: user.associateId },
      select: { calendarFeedVersion: true },
    });
    if (!associate) {
      throw new HttpError(404, 'no_associate', 'No associate profile linked');
    }
    res.json(
      buildCalendarFeedUrls(user.associateId, associate.calendarFeedVersion),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/me/calendar-url/rotate
 *
 * Invalidates the caller's current iCal URL (leaked link, ex-roommate's
 * laptop, ...) by bumping their calendarFeedVersion, and returns the new
 * URL. Only affects THIS associate — everyone else's subscriptions keep
 * working. Every calendar app subscribed to the old URL goes dark until
 * the new one is added, so the UI confirms before calling.
 */
schedulingRouter.post('/me/calendar-url/rotate', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'no_associate', 'No associate profile linked');
    }
    const associate = await prisma.associate.update({
      where: { id: user.associateId },
      data: { calendarFeedVersion: { increment: 1 } },
      select: { calendarFeedVersion: true },
    });
    enqueueAudit(
      {
        actorUserId: user.id,
        action: 'scheduling.calendar_feed_rotated',
        entityType: 'Associate',
        entityId: user.associateId,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          version: associate.calendarFeedVersion,
        },
      },
      'scheduling.calendar_feed_rotated'
    );
    res.json(
      buildCalendarFeedUrls(user.associateId, associate.calendarFeedVersion),
    );
  } catch (err) {
    next(err);
  }
});

/* ===== Conflict detection (HR/Ops) ===================================== */

/**
 * Returns existing assigned shifts that overlap the given target shift's
 * time window for the proposed associate. Used by the assign UI to warn
 * before clobbering. Doesn't block — the actual /assign endpoint still
 * runs; HR can override.
 */
schedulingRouter.get('/shifts/:id/conflicts', MANAGE, async (req, res, next) => {
  try {
    const associateId = req.query.associateId?.toString();
    const target = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
    });
    if (!target) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (!associateId) {
      res.json(ShiftConflictsResponseSchema.parse({ conflicts: [] }));
      return;
    }

    // Day-bound the target so we can match it against day-granular
    // TimeOffRequest rows (startDate / endDate are DATE columns).
    const targetStartDate = new Date(target.startsAt);
    targetStartDate.setUTCHours(0, 0, 0, 0);
    const targetEndDate = new Date(target.endsAt);
    targetEndDate.setUTCHours(0, 0, 0, 0);

    const [overlaps, ptoOverlaps] = await Promise.all([
      prisma.shift.findMany({
        take: 100,
        where: {
          assignedAssociateId: associateId,
          id: { not: target.id },
          status: { notIn: ['CANCELLED', 'COMPLETED'] },
          // Standard overlap: existing.starts < target.ends AND existing.ends > target.starts
          startsAt: { lt: target.endsAt },
          endsAt: { gt: target.startsAt },
        },
        include: { client: { select: { name: true } } },
      }),
      // Phase 52 — APPROVED time-off that intersects the shift's day range.
      prisma.timeOffRequest.findMany({
        take: 100,
        where: {
          associateId,
          status: 'APPROVED',
          startDate: { lte: targetEndDate },
          endDate: { gte: targetStartDate },
        },
      }),
    ]);

    const conflicts: ShiftConflict[] = overlaps.map((s) => ({
      conflictingShiftId: s.id,
      conflictingStartsAt: s.startsAt.toISOString(),
      conflictingEndsAt: s.endsAt.toISOString(),
      conflictingClientName: s.client?.name ?? null,
      conflictingPosition: s.position,
    }));
    const timeOffConflicts = ptoOverlaps.map((r) => ({
      requestId: r.id,
      category: r.category,
      startDate: r.startDate.toISOString().slice(0, 10),
      endDate: r.endDate.toISOString().slice(0, 10),
    }));
    res.json(ShiftConflictsResponseSchema.parse({ conflicts, timeOffConflicts }));
  } catch (err) {
    next(err);
  }
});

/* ===== Auto-fill candidate ranking (HR/Ops) ============================ */

/**
 * Rank associates by suitability for an OPEN shift. Ranking heuristic:
 *   - +0.5 if a posted availability window covers the shift
 *   - +0.3 if no scheduling conflict
 *   - +0.2 if their weekly scheduled hours leave room before 40h OT
 * Returns the top 25.
 */
schedulingRouter.get('/shifts/:id/auto-fill', MANAGE, async (req, res, next) => {
  try {
    const target = await prisma.shift.findFirst({
      where: { id: req.params.id, ...scopeShifts(req.user!) },
      include: { locationRel: { select: { timezone: true } } },
    });
    if (!target) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    // Availability is wall-clock at the STORE, so convert the shift's UTC
    // instant to the location's local day-of-week + minutes before matching.
    const targetTz = target.locationRel?.timezone ?? DEFAULT_TIMEZONE;

    // Day-bound the target so we can match it against day-granular PTO rows.
    const targetDayStart = new Date(target.startsAt);
    targetDayStart.setUTCHours(0, 0, 0, 0);
    const targetDayEnd = new Date(target.endsAt);
    targetDayEnd.setUTCHours(0, 0, 0, 0);

    const [associates, ptoRows] = await Promise.all([
      prisma.associate.findMany({
        where: ACTIVE_ASSOCIATE_FILTER,
        include: {
          assignedShifts: {
            where: {
              status: { notIn: ['CANCELLED', 'COMPLETED'] },
              startsAt: { gte: startOfWeekUTC(target.startsAt), lt: endOfWeekUTC(target.startsAt) },
            },
          },
          timeEntries: {
            where: {
              clockInAt: { gte: startOfWeekUTC(target.startsAt), lt: endOfWeekUTC(target.startsAt) },
            },
            include: { breaks: true },
          },
          availability: true,
        },
        take: 500,
      }),
      // Phase 52 — APPROVED PTO covering the shift's day window. One query
      // for the whole pool; we bucket by associateId in memory.
      prisma.timeOffRequest.findMany({
        take: 100,
        where: {
          status: 'APPROVED',
          startDate: { lte: targetDayEnd },
          endDate: { gte: targetDayStart },
        },
        select: { associateId: true },
      }),
    ]);

    const ptoAssociateIds = new Set(ptoRows.map((r) => r.associateId));

    const targetDOW = zonedDayOfWeek(target.startsAt, targetTz);
    const startMin = zonedMinutes(target.startsAt, targetTz);
    const endMin = zonedMinutes(target.endsAt, targetTz);

    const candidates: AutoFillCandidate[] = associates.map((a) => {
      const matchesAvailability = a.availability.some(
        (w) =>
          w.dayOfWeek === targetDOW &&
          w.startMinute <= startMin &&
          w.endMinute >= endMin
      );
      const noConflict = !a.assignedShifts.some(
        (s) => s.startsAt < target.endsAt && s.endsAt > target.startsAt
      );
      const onApprovedTimeOff = ptoAssociateIds.has(a.id);
      const weeklyMinutesScheduled = a.assignedShifts.reduce(
        (sum, s) => sum + Math.floor((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000),
        0
      );
      const weeklyMinutesActual = a.timeEntries.reduce(
        (sum, e) => sum + netWorkedMinutes(e, e.breaks),
        0
      );
      const targetMinutes = Math.floor(
        (target.endsAt.getTime() - target.startsAt.getTime()) / 60_000
      );
      const wouldExceed40 = weeklyMinutesActual + targetMinutes > 40 * 60;

      let score = 0;
      if (matchesAvailability) score += 0.5;
      if (noConflict) score += 0.3;
      if (!wouldExceed40) score += 0.2;
      // PTO is a deliberate plan — force these to the bottom of the list
      // regardless of availability or weekly hours.
      if (onApprovedTimeOff) score = 0;

      return {
        associateId: a.id,
        associateName: `${a.firstName} ${a.lastName}`,
        weeklyMinutesScheduled,
        weeklyMinutesActual,
        matchesAvailability,
        noConflict,
        onApprovedTimeOff,
        score,
      };
    });

    candidates.sort((x, y) => y.score - x.score);
    res.json(AutoFillResponseSchema.parse({ candidates: candidates.slice(0, 25) }));
  } catch (err) {
    next(err);
  }
});

/* ===== Associate availability ========================================== */

schedulingRouter.get('/me/availability', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(AvailabilityListResponseSchema.parse({ windows: [] }));
      return;
    }
    const rows = await prisma.associateAvailability.findMany({
      take: 500,
      where: { associateId: user.associateId },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    });
    const windows: AvailabilityWindow[] = rows.map((w) => ({
      id: w.id,
      associateId: w.associateId,
      dayOfWeek: w.dayOfWeek,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    }));
    res.json(AvailabilityListResponseSchema.parse({ windows }));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.put('/me/availability', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can set availability');
    }
    const parsed = AvailabilityReplaceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }

    await prisma.$transaction([
      prisma.associateAvailability.deleteMany({
        where: { associateId: user.associateId },
      }),
      prisma.associateAvailability.createMany({
        data: parsed.data.windows.map((w) => ({
          associateId: user.associateId!,
          dayOfWeek: w.dayOfWeek,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        })),
      }),
    ]);

    const rows = await prisma.associateAvailability.findMany({
      take: 500,
      where: { associateId: user.associateId },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    });
    const windows: AvailabilityWindow[] = rows.map((w) => ({
      id: w.id,
      associateId: w.associateId,
      dayOfWeek: w.dayOfWeek,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
    }));
    res.json(AvailabilityListResponseSchema.parse({ windows }));
  } catch (err) {
    next(err);
  }
});

/* ===== Shift swap marketplace ========================================== */

type RawSwap = Prisma.ShiftSwapRequestGetPayload<{
  include: {
    shift: {
      include: {
        client: { select: { name: true } };
        locationRel: { select: { timezone: true } };
      };
    };
    counterpartShift: {
      include: {
        client: { select: { name: true } };
        locationRel: { select: { timezone: true } };
      };
    };
    requester: { select: { firstName: true; lastName: true } };
    counterparty: { select: { firstName: true; lastName: true } };
  };
}>;

const SWAP_INCLUDE = {
  shift: {
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  },
  counterpartShift: {
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  },
  requester: { select: { firstName: true, lastName: true } },
  counterparty: { select: { firstName: true, lastName: true } },
} as const;

function toSwap(row: RawSwap): ShiftSwapRequestDTO {
  return {
    id: row.id,
    shiftId: row.shiftId,
    shiftStartsAt: row.shift.startsAt.toISOString(),
    shiftEndsAt: row.shift.endsAt.toISOString(),
    shiftTimezone: row.shift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
    shiftPosition: row.shift.position,
    shiftClientName: row.shift.client?.name ?? null,
    inExchange: row.counterpartShift
      ? {
          shiftId: row.counterpartShift.id,
          position: row.counterpartShift.position,
          clientName: row.counterpartShift.client?.name ?? null,
          startsAt: row.counterpartShift.startsAt.toISOString(),
          endsAt: row.counterpartShift.endsAt.toISOString(),
          timezone: row.counterpartShift.locationRel?.timezone ?? DEFAULT_TIMEZONE,
        }
      : null,
    requesterAssociateId: row.requesterAssociateId,
    requesterName: `${row.requester.firstName} ${row.requester.lastName}`,
    counterpartyAssociateId: row.counterpartyAssociateId,
    counterpartyName: `${row.counterparty.firstName} ${row.counterparty.lastName}`,
    status: row.status,
    note: row.note,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Associate creates a swap request — they own the shift and propose
 *  someone else takes it. Counterparty must be qualified (HR can still
 *  reject). */
schedulingRouter.post('/swap-requests', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates can request swaps');
    }
    const parsed = SwapCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { shiftId, counterpartyAssociateId, note, counterpartShiftId } = parsed.data;

    if (counterpartyAssociateId === user.associateId) {
      throw new HttpError(400, 'self_swap', 'You cannot swap a shift with yourself');
    }
    const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found');
    if (shift.assignedAssociateId !== user.associateId) {
      throw new HttpError(403, 'not_your_shift', 'You can only swap shifts assigned to you');
    }
    if (shift.status !== 'ASSIGNED') {
      throw new HttpError(409, 'shift_not_assigned', 'Shift is not in an assignable state');
    }
    const counterparty = await prisma.associate.findFirst({
      where: { id: counterpartyAssociateId, deletedAt: null },
    });
    if (!counterparty) throw new HttpError(404, 'counterparty_not_found', 'Counterparty associate not found');

    // Trade half: the exchange shift must be a real, upcoming, published
    // shift OF THE COUNTERPARTY — otherwise this degrades into a lever for
    // grabbing arbitrary shifts. Deeper checks (double-booking both ways)
    // run at manager-approve time, when they're actually decisive.
    if (counterpartShiftId) {
      if (counterpartShiftId === shiftId) {
        throw new HttpError(400, 'same_shift', 'Exchange shift must differ from yours');
      }
      const exchange = await prisma.shift.findUnique({ where: { id: counterpartShiftId } });
      if (
        !exchange ||
        exchange.assignedAssociateId !== counterpartyAssociateId ||
        exchange.status !== 'ASSIGNED' ||
        !exchange.publishedAt ||
        exchange.startsAt <= new Date()
      ) {
        throw new HttpError(
          409,
          'invalid_exchange_shift',
          "The exchange shift must be one of the counterparty's upcoming shifts",
        );
      }
    }

    const created = await prisma.shiftSwapRequest.create({
      data: {
        shiftId,
        requesterAssociateId: user.associateId,
        counterpartyAssociateId,
        counterpartShiftId: counterpartShiftId ?? null,
        note: note ?? null,
        status: 'PENDING_PEER',
      },
      include: SWAP_INCLUDE,
    });

    await notifyShift(prisma, {
      associateId: counterpartyAssociateId,
      subject: 'New swap request',
      body: `${created.requester.firstName} ${created.requester.lastName} is asking you to take their shift: ${formatShiftLine(
        {
          position: created.shift.position,
          clientName: created.shift.client?.name ?? null,
          startsAt: created.shift.startsAt,
          endsAt: created.shift.endsAt,
        }
      )}${note ? `\nNote: ${note}` : ''}`,
      category: 'swap_peer_request',
      senderUserId: req.user!.id,
    });
    // Manager copy: the requester's manager should know a swap is in flight
    // so they can intervene if the peer rejects. No-op if no manager.
    const mgrSwapTpl = shiftSwapManagerTemplate({
      requesterName: `${created.requester.firstName} ${created.requester.lastName}`,
      counterpartyName: `${counterparty.firstName} ${counterparty.lastName}`,
      position: created.shift.position,
      clientName: created.shift.client?.name ?? 'the client',
      shiftDate: created.shift.startsAt.toISOString().slice(0, 10),
      startsAt: created.shift.startsAt.toISOString().slice(11, 16) + ' UTC',
      endsAt: created.shift.endsAt.toISOString().slice(11, 16) + ' UTC',
    });
    void notifyManager(user.associateId, {
      subject: mgrSwapTpl.subject,
      body: mgrSwapTpl.text,
      html: mgrSwapTpl.html,
      category: 'scheduling',
    });

    res.status(201).json(toSwap(created));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /scheduling/me/trade-options?counterpartyId=<uuid>
 *
 * The counterparty's upcoming published shifts — what the requester can
 * ask for in exchange. Position/times only, same exposure rationale as
 * the teammates panel.
 */
schedulingRouter.get('/me/trade-options', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Forbidden');
    }
    const counterpartyId = req.query.counterpartyId?.toString();
    if (!counterpartyId || !/^[0-9a-f-]{36}$/i.test(counterpartyId)) {
      throw new HttpError(400, 'invalid_counterparty', 'counterpartyId required');
    }
    const rows = await prisma.shift.findMany({
      where: {
        assignedAssociateId: counterpartyId,
        status: 'ASSIGNED',
        publishedAt: { not: null },
        startsAt: { gt: new Date() },
      },
      orderBy: { startsAt: 'asc' },
      take: 20,
      include: {
        client: { select: { name: true } },
        locationRel: { select: { timezone: true } },
      },
    });
    res.json(
      TradeOptionsResponseSchema.parse({
        options: rows.map((s) => ({
          shiftId: s.id,
          position: s.position,
          clientName: s.client?.name ?? null,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          timezone: s.locationRel?.timezone ?? DEFAULT_TIMEZONE,
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.get('/swap-requests/me/incoming', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(ShiftSwapListResponseSchema.parse({ requests: [] }));
      return;
    }
    const rows = await prisma.shiftSwapRequest.findMany({
      take: 500,
      where: { counterpartyAssociateId: user.associateId },
      orderBy: { createdAt: 'desc' },
      include: SWAP_INCLUDE,
    });
    res.json(ShiftSwapListResponseSchema.parse({ requests: rows.map(toSwap) }));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.get('/swap-requests/me/outgoing', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(ShiftSwapListResponseSchema.parse({ requests: [] }));
      return;
    }
    const rows = await prisma.shiftSwapRequest.findMany({
      take: 500,
      where: { requesterAssociateId: user.associateId },
      orderBy: { createdAt: 'desc' },
      include: SWAP_INCLUDE,
    });
    res.json(ShiftSwapListResponseSchema.parse({ requests: rows.map(toSwap) }));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/peer-accept', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only the counterparty associate can accept');
    }
    const swap = await prisma.shiftSwapRequest.findUnique({ where: { id: req.params.id } });
    if (!swap) throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    if (swap.counterpartyAssociateId !== user.associateId) {
      throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    }
    if (swap.status !== 'PENDING_PEER') {
      throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot accept`);
    }
    // Atomic compare-and-set so a double-tap can't accept twice (which would
    // fire the HR-approval notification twice and race the manager flow).
    const cas = await prisma.shiftSwapRequest.updateMany({
      where: { id: swap.id, status: 'PENDING_PEER' },
      data: { status: 'PEER_ACCEPTED' },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'invalid_state', 'This swap was already resolved.');
    }
    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });

    await notifyShift(prisma, {
      associateId: updated.requesterAssociateId,
      subject: 'Swap accepted — pending HR approval',
      body: `${updated.counterparty.firstName} ${updated.counterparty.lastName} accepted your swap request. Waiting on HR sign-off: ${formatShiftLine(
        {
          position: updated.shift.position,
          clientName: updated.shift.client?.name ?? null,
          startsAt: updated.shift.startsAt,
          endsAt: updated.shift.endsAt,
          timezone: updated.shift.locationRel?.timezone ?? null,
        }
      )}`,
      category: 'swap_peer_accepted',
      senderUserId: req.user!.id,
    });

    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/peer-decline', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only the counterparty associate can decline');
    }
    const swap = await prisma.shiftSwapRequest.findUnique({ where: { id: req.params.id } });
    if (!swap || swap.counterpartyAssociateId !== user.associateId) {
      throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    }
    if (swap.status !== 'PENDING_PEER') {
      throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot decline`);
    }
    // CAS, same as peer-accept — a decline racing an accept must lose to
    // whichever landed first instead of overwriting it.
    const cas = await prisma.shiftSwapRequest.updateMany({
      where: { id: swap.id, status: 'PENDING_PEER' },
      data: { status: 'PEER_DECLINED' },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'invalid_state', 'This swap was already resolved.');
    }
    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });

    await notifyShift(prisma, {
      associateId: updated.requesterAssociateId,
      subject: 'Swap declined',
      body: `${updated.counterparty.firstName} ${updated.counterparty.lastName} declined your swap request for ${formatShiftLine(
        {
          position: updated.shift.position,
          clientName: updated.shift.client?.name ?? null,
          startsAt: updated.shift.startsAt,
          endsAt: updated.shift.endsAt,
          timezone: updated.shift.locationRel?.timezone ?? null,
        }
      )}`,
      category: 'swap_peer_declined',
      senderUserId: req.user!.id,
    });

    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/cancel', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Forbidden');
    }
    const swap = await prisma.shiftSwapRequest.findUnique({ where: { id: req.params.id } });
    if (!swap || swap.requesterAssociateId !== user.associateId) {
      throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    }
    if (swap.status === 'MANAGER_APPROVED' || swap.status === 'CANCELLED') {
      throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot cancel`);
    }
    // Guarded write: re-assert "not yet approved" AT WRITE TIME. Without
    // this, a cancel racing manager-approve could stamp CANCELLED over an
    // approved swap whose assignment already moved (June audit P0).
    const cas = await prisma.shiftSwapRequest.updateMany({
      where: {
        id: swap.id,
        status: { notIn: ['MANAGER_APPROVED', 'CANCELLED'] },
      },
      data: { status: 'CANCELLED' },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'invalid_state', 'This swap was already resolved.');
    }
    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });
    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.get('/swap-requests/admin', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const where: Prisma.ShiftSwapRequestWhereInput = {
      // Scope to swaps for shifts the caller can see (a CLIENT_PORTAL admin
      // must not read other clients' swap activity). scopeShifts is {} for
      // full admins, so this is a no-op for them.
      shift: { is: scopeShifts(req.user!) },
      ...(status ? { status: status as Prisma.ShiftSwapRequestWhereInput['status'] } : {}),
    };
    const rows = await prisma.shiftSwapRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: SWAP_INCLUDE,
    });
    res.json(ShiftSwapListResponseSchema.parse({ requests: rows.map(toSwap) }));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/manager-approve', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = SwapDecideInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    // Scope to a swap whose shift the caller can manage — a CLIENT_PORTAL
    // admin must not approve another client's swap by guessing the id.
    const swap = await prisma.shiftSwapRequest.findFirst({
      where: { id: req.params.id, shift: { is: scopeShifts(req.user!) } },
      include: { shift: true, counterpartShift: true },
    });
    if (!swap) throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    if (swap.status !== 'PEER_ACCEPTED') {
      throw new HttpError(
        409,
        'not_peer_accepted',
        'Counterparty must accept the swap before HR approval'
      );
    }

    // Execute atomically: CAS the swap status, verify neither party is
    // double-booked by the leg they're taking, then move the assignment(s)
    // with WRITE-TIME preconditions — the shift must still be ASSIGNED to
    // the expected person (June audit P0: an approve racing a shift
    // cancel/unassign used to resurrect the assignment blindly). Trades
    // move both legs or none. Any throw rolls the whole thing back.
    const isTrade = !!swap.counterpartShiftId && !!swap.counterpartShift;
    const excludeIds = isTrade
      ? [swap.shiftId, swap.counterpartShiftId!]
      : [swap.shiftId];
    await prisma.$transaction(async (tx) => {
      const cas = await tx.shiftSwapRequest.updateMany({
        where: { id: swap.id, status: 'PEER_ACCEPTED' },
        data: { status: 'MANAGER_APPROVED', decidedById: user.id, decidedAt: new Date() },
      });
      if (cas.count === 0) {
        throw new HttpError(409, 'invalid_state', 'This swap was already decided.');
      }
      if (
        await hasOverlapExcluding(
          tx,
          swap.counterpartyAssociateId,
          swap.shift.startsAt,
          swap.shift.endsAt,
          excludeIds,
        )
      ) {
        throw new HttpError(
          409,
          'counterparty_double_booked',
          'The counterparty now has another shift overlapping this one — they can’t take it.',
        );
      }
      if (
        isTrade &&
        (await hasOverlapExcluding(
          tx,
          swap.requesterAssociateId,
          swap.counterpartShift!.startsAt,
          swap.counterpartShift!.endsAt,
          excludeIds,
        ))
      ) {
        throw new HttpError(
          409,
          'requester_double_booked',
          'The requester now has another shift overlapping the exchange shift.',
        );
      }
      const main = await tx.shift.updateMany({
        where: {
          id: swap.shiftId,
          status: 'ASSIGNED',
          assignedAssociateId: swap.requesterAssociateId,
        },
        data: {
          assignedAssociateId: swap.counterpartyAssociateId,
          assignedAt: new Date(),
          // New owner hasn't confirmed anything — reset the ack.
          acknowledgedAt: null,
        },
      });
      if (main.count === 0) {
        throw new HttpError(
          409,
          'shift_changed',
          'The shift was cancelled or reassigned while this swap was pending.',
        );
      }
      if (isTrade) {
        const leg = await tx.shift.updateMany({
          where: {
            id: swap.counterpartShiftId!,
            status: 'ASSIGNED',
            assignedAssociateId: swap.counterpartyAssociateId,
          },
          data: {
            assignedAssociateId: swap.requesterAssociateId,
            assignedAt: new Date(),
            acknowledgedAt: null,
          },
        });
        if (leg.count === 0) {
          throw new HttpError(
            409,
            'exchange_shift_changed',
            'The exchange shift was cancelled or reassigned while this swap was pending.',
          );
        }
      }
    });

    await recordShiftEvent({
      actorUserId: user.id,
      action: 'shift.swapped',
      shiftId: swap.shiftId,
      clientId: swap.shift.clientId,
      metadata: {
        from: swap.requesterAssociateId,
        to: swap.counterpartyAssociateId,
        swapRequestId: swap.id,
        trade: isTrade,
      },
      req,
    });
    if (isTrade) {
      await recordShiftEvent({
        actorUserId: user.id,
        action: 'shift.swapped',
        shiftId: swap.counterpartShiftId!,
        clientId: swap.counterpartShift!.clientId,
        metadata: {
          from: swap.counterpartyAssociateId,
          to: swap.requesterAssociateId,
          swapRequestId: swap.id,
          trade: true,
        },
        req,
      });
    }

    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });

    // Both parties get notified — the new owner needs to know it's now
    // theirs, and the original owner needs to know they're off the hook.
    const shiftLine = formatShiftLine({
      position: updated.shift.position,
      clientName: updated.shift.client?.name ?? null,
      startsAt: updated.shift.startsAt,
      endsAt: updated.shift.endsAt,
      timezone: updated.shift.locationRel?.timezone ?? null,
    });
    const exchangeLine = updated.counterpartShift
      ? formatShiftLine({
          position: updated.counterpartShift.position,
          clientName: updated.counterpartShift.client?.name ?? null,
          startsAt: updated.counterpartShift.startsAt,
          endsAt: updated.counterpartShift.endsAt,
          timezone: updated.counterpartShift.locationRel?.timezone ?? null,
        })
      : null;
    await notifyShift(prisma, {
      associateId: updated.counterpartyAssociateId,
      subject: 'Swap approved — shift is yours',
      body:
        `HR approved the swap. You're now scheduled for: ${shiftLine}` +
        (exchangeLine ? `\nYou handed off: ${exchangeLine}` : ''),
      category: 'swap_manager_approved',
      senderUserId: req.user!.id,
    });
    await notifyShift(prisma, {
      associateId: updated.requesterAssociateId,
      subject: 'Swap approved — shift handed off',
      body:
        `HR approved your swap with ${updated.counterparty.firstName} ${updated.counterparty.lastName}. You're off this shift: ${shiftLine}` +
        (exchangeLine ? `\nIn exchange you're now on: ${exchangeLine}` : ''),
      category: 'swap_manager_approved',
      senderUserId: req.user!.id,
    });

    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/swap-requests/:id/manager-reject', MANAGE, async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = SwapDecideInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const swap = await prisma.shiftSwapRequest.findFirst({
      where: { id: req.params.id, shift: { is: scopeShifts(req.user!) } },
    });
    if (!swap) throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    if (swap.status === 'MANAGER_APPROVED' || swap.status === 'MANAGER_REJECTED' || swap.status === 'CANCELLED') {
      throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot reject`);
    }
    // Guarded write — mirrors cancel: never overwrite a terminal state
    // that landed between our read and this update.
    const cas = await prisma.shiftSwapRequest.updateMany({
      where: {
        id: swap.id,
        status: { in: ['PENDING_PEER', 'PEER_ACCEPTED', 'PEER_DECLINED'] },
      },
      data: { status: 'MANAGER_REJECTED', decidedById: user.id, decidedAt: new Date() },
    });
    if (cas.count === 0) {
      throw new HttpError(409, 'invalid_state', 'This swap was already resolved.');
    }
    const updated = await prisma.shiftSwapRequest.findUniqueOrThrow({
      where: { id: swap.id },
      include: SWAP_INCLUDE,
    });

    // Notify both parties so the requester knows to find another solution
    // and the counterparty isn't left wondering.
    const shiftLine = formatShiftLine({
      position: updated.shift.position,
      clientName: updated.shift.client?.name ?? null,
      startsAt: updated.shift.startsAt,
      endsAt: updated.shift.endsAt,
      timezone: updated.shift.locationRel?.timezone ?? null,
    });
    await notifyShift(prisma, {
      associateId: updated.requesterAssociateId,
      subject: 'Swap rejected by HR',
      body: `HR did not approve your swap for: ${shiftLine}`,
      category: 'swap_manager_rejected',
      senderUserId: req.user!.id,
    });
    await notifyShift(prisma, {
      associateId: updated.counterpartyAssociateId,
      subject: 'Swap rejected by HR',
      body: `HR did not approve the swap you accepted for: ${shiftLine}`,
      category: 'swap_manager_rejected',
      senderUserId: req.user!.id,
    });

    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== Phase 51 — shift templates + copy-week ============================ */

type RawTemplate = Prisma.ShiftTemplateGetPayload<{
  include: { client: { select: { name: true } } };
}>;

function toTemplate(row: RawTemplate): ShiftTemplateDTO {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    name: row.name,
    position: row.position,
    dayOfWeek: row.dayOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    location: row.location,
    hourlyRate: row.hourlyRate ? Number(row.hourlyRate) : null,
    payRate: row.payRate ? Number(row.payRate) : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

const TEMPLATE_INCLUDE = {
  client: { select: { name: true } },
} as const;

/**
 * GET /scheduling/templates?clientId=X
 * When clientId is supplied, returns templates for that client + every
 * global template. Without clientId, returns ALL non-deleted templates
 * (HR overview).
 */
schedulingRouter.get('/templates', MANAGE, async (req, res, next) => {
  try {
    const clientId = req.query.clientId?.toString();
    const where: Prisma.ShiftTemplateWhereInput = {
      deletedAt: null,
      ...(clientId ? { OR: [{ clientId }, { clientId: null }] } : {}),
    };
    const rows = await prisma.shiftTemplate.findMany({
      take: 1000,
      where,
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
      include: TEMPLATE_INCLUDE,
    });
    res.json(
      ShiftTemplateListResponseSchema.parse({ templates: rows.map(toTemplate) })
    );
  } catch (err) {
    next(err);
  }
});

schedulingRouter.post('/templates', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftTemplateCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;
    if (i.clientId) {
      const c = await prisma.client.findFirst({ where: { id: i.clientId, deletedAt: null } });
      if (!c) throw new HttpError(404, 'client_not_found', 'Client not found');
    }
    const created = await prisma.shiftTemplate.create({
      data: {
        clientId: i.clientId,
        name: i.name,
        position: i.position,
        dayOfWeek: i.dayOfWeek,
        startMinute: i.startMinute,
        endMinute: i.endMinute,
        location: i.location ?? null,
        hourlyRate: i.hourlyRate ?? null,
        payRate: i.payRate ?? null,
        notes: i.notes ?? null,
      },
      include: TEMPLATE_INCLUDE,
    });
    res.status(201).json(toTemplate(created));
  } catch (err) {
    next(err);
  }
});

schedulingRouter.delete('/templates/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.shiftTemplate.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) throw new HttpError(404, 'template_not_found', 'Template not found');
    await prisma.shiftTemplate.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/templates/:id/apply
 * Body: { weekStart, clientId? }
 * Stamps a DRAFT shift on the template's dayOfWeek of the target week.
 * Returns the created shift.
 */
schedulingRouter.post('/templates/:id/apply', MANAGE, async (req, res, next) => {
  try {
    const parsed = ShiftTemplateApplyInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const tpl = await prisma.shiftTemplate.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!tpl) throw new HttpError(404, 'template_not_found', 'Template not found');

    const clientId = tpl.clientId ?? parsed.data.clientId;
    if (!clientId) {
      throw new HttpError(
        400,
        'client_required',
        'Global templates require a clientId at apply time'
      );
    }
    // Phase 131 — derive locationId from the resolved client.
    const location = await firstLocationForClient(prisma, clientId);

    // Snap the supplied weekStart to local Sunday at 00:00, then advance
    // by `dayOfWeek` days. Local time keeps templates intuitive — "9am
    // Friday" is whatever 9am means in the user's timezone.
    const anchor = new Date(parsed.data.weekStart);
    anchor.setHours(0, 0, 0, 0);
    anchor.setDate(anchor.getDate() - anchor.getDay());
    const target = new Date(anchor);
    target.setDate(target.getDate() + tpl.dayOfWeek);
    const startsAt = new Date(target);
    startsAt.setHours(0, tpl.startMinute, 0, 0);
    const endsAt = new Date(target);
    endsAt.setHours(0, tpl.endMinute, 0, 0);
    // Overnight templates: endMinute <= startMinute means roll endsAt to
    // the next day so duration is positive.
    if (endsAt <= startsAt) endsAt.setDate(endsAt.getDate() + 1);

    const created = await prisma.shift.create({
      data: {
        clientId,
        locationId: location.id,
        position: tpl.position,
        startsAt,
        endsAt,
        location: tpl.location,
        hourlyRate: tpl.hourlyRate,
        payRate: tpl.payRate,
        notes: tpl.notes,
        status: 'DRAFT',
        createdById: req.user!.id,
      },
      include: SHIFT_INCLUDE,
    });

    await recordShiftEvent({
      actorUserId: req.user!.id,
      action: 'shift.created_from_template',
      shiftId: created.id,
      clientId: created.clientId,
      metadata: { templateId: tpl.id, templateName: tpl.name },
      req,
    });

    res.status(201).json(toShift(created));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/copy-week
 * Body: { sourceWeekStart, targetWeekStart, clientId? }
 *
 * Duplicates every non-cancelled shift from the source week into the
 * target week, preserving day-of-week + time-of-day. New shifts land in
 * DRAFT with no assignee — HR re-publishes after review. Idempotency
 * is on the user; calling twice produces duplicates.
 */
schedulingRouter.post('/copy-week', MANAGE, async (req, res, next) => {
  try {
    const parsed = CopyWeekInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const snap = (iso: string): Date => {
      const d = new Date(iso);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - d.getDay());
      return d;
    };
    const source = snap(parsed.data.sourceWeekStart);
    const target = snap(parsed.data.targetWeekStart);
    const sourceEnd = new Date(source);
    sourceEnd.setDate(sourceEnd.getDate() + 7);

    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      startsAt: { gte: source, lt: sourceEnd },
      status: { not: 'CANCELLED' },
      ...(parsed.data.clientId ? { clientId: parsed.data.clientId } : {}),
    };
    const sourceShifts = await prisma.shift.findMany({ take: 100, where });
    if (sourceShifts.length === 0) {
      const empty: CopyWeekResponse = { created: 0, skipped: 0 };
      res.json(empty);
      return;
    }

    const offsetMs = target.getTime() - source.getTime();
    // Phase 131 — preserve the source shift's locationId so copy-week
    // doesn't drop the FK. Source rows always have one (set by the PR
    // 1 backfill and by every writer since).
    const data = sourceShifts.map((s) => ({
      clientId: s.clientId,
      locationId: s.locationId,
      position: s.position,
      startsAt: new Date(s.startsAt.getTime() + offsetMs),
      endsAt: new Date(s.endsAt.getTime() + offsetMs),
      location: s.location,
      hourlyRate: s.hourlyRate,
      payRate: s.payRate,
      notes: s.notes,
      status: 'DRAFT' as const,
      createdById: req.user!.id,
    }));
    const result = await prisma.shift.createMany({ data });

    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'scheduling.copied_week',
        entityType: 'Shift',
        entityId: source.toISOString(),
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          source: source.toISOString(),
          target: target.toISOString(),
          createdCount: result.count,
        },
      },
      'scheduling.copied_week'
    );

    const body: CopyWeekResponse = { created: result.count, skipped: 0 };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/publish-week
 * Body: { weekStart, clientId? }
 *
 * Phase 53 — flips every DRAFT shift in the week to OPEN (no assignee) or
 * ASSIGNED (assignee set). Stamps publishedAt = now and sends the same
 * "shift_published" notification the per-shift PATCH path sends.
 *
 * Predictive-scheduling guard: a shift in a covered state that's inside
 * the 14-day notice window without a documented `lateNoticeReason` is
 * SKIPPED rather than failing the whole batch — HR can still publish the
 * compliant ones in one click and resolve the noisy ones individually.
 */
schedulingRouter.post('/publish-week', MANAGE, async (req, res, next) => {
  try {
    const parsed = PublishWeekInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    // Snap to local Monday 00:00 — matches the week the UI is showing.
    const start = new Date(parsed.data.weekStart);
    start.setHours(0, 0, 0, 0);
    const dow = (start.getDay() + 6) % 7; // Mon=0..Sun=6
    start.setDate(start.getDate() - dow);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      status: 'DRAFT',
      startsAt: { gte: start, lt: end },
      ...(parsed.data.clientId ? { clientId: parsed.data.clientId } : {}),
    };
    const drafts = await prisma.shift.findMany({
      take: 100,
      where,
      include: {
        client: { select: { state: true, name: true } },
        assignedAssociate: { select: { firstName: true, lastName: true } },
        locationRel: { select: { timezone: true } },
      },
    });

    const now = new Date();
    const skipped: PublishWeekSkip[] = [];
    const publishable: typeof drafts = [];

    // Tracks each associate's occupied windows as this batch is admitted,
    // so two overlapping DRAFTS for the same person can't both publish
    // (June audit P0 — publish-week had no double-booking guard).
    const admittedByAssociate = new Map<string, { startsAt: Date; endsAt: Date }[]>();

    for (const s of drafts) {
      const evaluation = evaluateShiftNotice({
        state: s.client.state,
        startsAt: s.startsAt,
        publishAt: now,
      });
      if (evaluation.requiresReason && !s.lateNoticeReason) {
        skipped.push({
          shiftId: s.id,
          reason: 'predictive_schedule_violation',
          detail: `Inside 14-day notice window in ${evaluation.state} — open the shift and add lateNoticeReason before publishing.`,
        });
        continue;
      }
      if (s.assignedAssociateId) {
        const inBatch = admittedByAssociate.get(s.assignedAssociateId) ?? [];
        const clashesInBatch = inBatch.some(
          (w) => w.startsAt < s.endsAt && w.endsAt > s.startsAt,
        );
        // DB check counts only LIVE shifts — other drafts are handled by
        // the in-batch tracker above (they'd otherwise veto each other and
        // publish nothing).
        const liveClash = await prisma.shift.findFirst({
          where: {
            id: { not: s.id },
            assignedAssociateId: s.assignedAssociateId,
            status: { notIn: ['CANCELLED', 'DRAFT'] },
            startsAt: { lt: s.endsAt },
            endsAt: { gt: s.startsAt },
          },
          select: { id: true },
        });
        if (clashesInBatch || liveClash) {
          skipped.push({
            shiftId: s.id,
            reason: 'double_booking',
            detail:
              'Publishing would double-book the assigned associate — adjust the times or reassign first.',
          });
          continue;
        }
        inBatch.push({ startsAt: s.startsAt, endsAt: s.endsAt });
        admittedByAssociate.set(s.assignedAssociateId, inBatch);
      }
      publishable.push(s);
    }

    // Bucket publishable shifts by assignee so we can send ONE digest
    // notification per associate at the end. Without this, a person with
    // five shifts in the published week would get five push pings — fine
    // for a single change, spammy on a batch publish.
    // Bucket by assignee (for the per-associate digests below) and split by
    // target status — assigned shifts publish to ASSIGNED, unassigned to OPEN.
    const perAssociate = new Map<string, typeof publishable>();
    const assignedIds: string[] = [];
    const openIds: string[] = [];
    for (const s of publishable) {
      if (s.assignedAssociateId) {
        assignedIds.push(s.id);
        const bucket = perAssociate.get(s.assignedAssociateId) ?? [];
        bucket.push(s);
        perAssociate.set(s.assignedAssociateId, bucket);
      } else {
        openIds.push(s.id);
      }
    }
    const publishedCount = publishable.length;

    // Two bulk writes instead of one update per shift (a big week was 100+
    // serial round-trips that could brush the request timeout).
    await prisma.$transaction([
      ...(assignedIds.length > 0
        ? [
            prisma.shift.updateMany({
              where: { id: { in: assignedIds } },
              data: { status: 'ASSIGNED', publishedAt: now },
            }),
          ]
        : []),
      ...(openIds.length > 0
        ? [
            prisma.shift.updateMany({
              where: { id: { in: openIds } },
              data: { status: 'OPEN', publishedAt: now },
            }),
          ]
        : []),
    ]);

    // One audit event for the whole batch (per-shift events were the other
    // half of the N+1).
    if (publishedCount > 0) {
      await recordShiftEvent({
        actorUserId: req.user!.id,
        action: 'shift.updated',
        shiftId: publishable[0]!.id,
        clientId: publishable[0]!.clientId,
        metadata: {
          fields: ['status', 'publishedAt'],
          publish: 'week',
          count: publishedCount,
        },
        req,
      });
    }

    // One digest per associate, ordered chronologically. Subject scales
    // with the count so a single-shift batch reads naturally.
    for (const [associateId, shifts] of perAssociate) {
      shifts.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const lines = shifts.map((s) =>
        formatShiftLine({
          position: s.position,
          clientName: s.client?.name ?? null,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          timezone: s.locationRel?.timezone ?? null,
        }),
      );
      const subject =
        shifts.length === 1
          ? 'Shift published'
          : `${shifts.length} shifts published`;
      const body =
        shifts.length === 1
          ? `Now on your schedule: ${lines[0]}`
          : `Now on your schedule:\n${lines.map((l) => `• ${l}`).join('\n')}`;
      await notifyShift(prisma, {
        associateId,
        subject,
        body,
        category: 'shift_published',
        senderUserId: req.user!.id,
      });
    }

    const body: PublishWeekResponse = { published: publishedCount, skipped };
    res.json(PublishWeekResponseSchema.parse(body));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/auto-schedule-week
 * Body: { weekStart, clientId? }
 *
 * One-click "fill the week" — for every OPEN shift in the snapped Mon–Sun
 * window, picks the best-scoring associate using the same heuristic as
 * /shifts/:id/auto-fill (availability match, no conflict, room before 40h
 * OT, PTO is a hard veto), and assigns them. Earlier shifts get first
 * claim on candidates so a popular associate isn't sniped from a Monday
 * morning by a Friday evening that scored them slightly higher.
 *
 * Stays in DRAFT-or-current status — does NOT touch publishedAt. Manager
 * still has to hit "Publish week" before associates see anything, which
 * means no notifications fire here either (the publish-week digest is
 * the single broadcast moment).
 *
 * Skipped shifts come back in the response with a reason so the manager
 * can see exactly which slots still need a human decision.
 */
schedulingRouter.post('/auto-schedule-week', MANAGE, async (req, res, next) => {
  try {
    const parsed = AutoScheduleWeekInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    // Snap to local Monday 00:00 — matches the week the UI is showing.
    const start = new Date(parsed.data.weekStart);
    start.setHours(0, 0, 0, 0);
    const dow = (start.getDay() + 6) % 7; // Mon=0..Sun=6
    start.setDate(start.getDate() - dow);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      status: 'OPEN',
      assignedAssociateId: null,
      startsAt: { gte: start, lt: end },
      ...(parsed.data.clientId ? { clientId: parsed.data.clientId } : {}),
    };

    // Earlier shifts go first so they get first pick of candidates.
    const openShifts = await prisma.shift.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: 2000,
      include: { locationRel: { select: { timezone: true } } },
    });

    if (openShifts.length === 0) {
      const empty: AutoScheduleWeekResponse = {
        assigned: 0,
        skipped: [],
        byAssociate: [],
      };
      res.json(AutoScheduleWeekResponseSchema.parse(empty));
      return;
    }

    // Pull the candidate pool ONCE for the whole week. We mutate the
    // in-memory state below as we assign so that consecutive iterations
    // don't double-book the same associate or push them over 40h.
    const weekStartUTC = startOfWeekUTC(openShifts[0].startsAt);
    const weekEndUTC = endOfWeekUTC(openShifts[0].startsAt);

    const [associates, ptoRows, exceptionRows] = await Promise.all([
      prisma.associate.findMany({
        where: ACTIVE_ASSOCIATE_FILTER,
        include: {
          assignedShifts: {
            where: {
              status: { notIn: ['CANCELLED', 'COMPLETED'] },
              startsAt: { gte: weekStartUTC, lt: weekEndUTC },
            },
            select: { startsAt: true, endsAt: true },
          },
          timeEntries: {
            where: { clockInAt: { gte: weekStartUTC, lt: weekEndUTC } },
            include: { breaks: true },
          },
          availability: true,
        },
        take: 1000,
      }),
      prisma.timeOffRequest.findMany({
        take: 100,
        where: {
          status: 'APPROVED',
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { associateId: true, startDate: true, endDate: true },
      }),
      // One-off "can't work this day" exceptions — same veto as PTO, so
      // they merge into the pto ranges below as single-day blocks.
      prisma.availabilityException.findMany({
        take: 500,
        where: { date: { gte: start, lte: end } },
        select: { associateId: true, date: true },
      }),
    ]);

    type AssocState = {
      id: string;
      name: string;
      availability: { dayOfWeek: number; startMinute: number; endMinute: number }[];
      // mutable: shifts already-assigned for THIS week (pre-existing + auto-added)
      busy: { startsAt: Date; endsAt: Date }[];
      // mutable: minutes already worked (actual + scheduled this week)
      weeklyMinutes: number;
      // PTO ranges that block specific shift days
      pto: { start: Date; end: Date }[];
    };

    const ptoByAssociate = new Map<string, { start: Date; end: Date }[]>();
    for (const r of ptoRows) {
      const list = ptoByAssociate.get(r.associateId) ?? [];
      list.push({ start: r.startDate, end: r.endDate });
      ptoByAssociate.set(r.associateId, list);
    }
    for (const x of exceptionRows) {
      const list = ptoByAssociate.get(x.associateId) ?? [];
      list.push({ start: x.date, end: x.date });
      ptoByAssociate.set(x.associateId, list);
    }

    const states: AssocState[] = associates.map((a) => {
      const scheduledMins = a.assignedShifts.reduce(
        (sum, s) => sum + Math.floor((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000),
        0,
      );
      const actualMins = a.timeEntries.reduce(
        (sum, e) => sum + netWorkedMinutes(e, e.breaks),
        0,
      );
      return {
        id: a.id,
        name: `${a.firstName} ${a.lastName}`,
        availability: a.availability.map((w) => ({
          dayOfWeek: w.dayOfWeek,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        })),
        busy: a.assignedShifts.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
        // Use the larger of scheduled-or-actual as the "minutes consumed"
        // baseline — same idea as the per-shift /auto-fill route, which
        // checks against actuals to avoid pushing someone past 40h OT.
        weeklyMinutes: Math.max(scheduledMins, actualMins),
        pto: ptoByAssociate.get(a.id) ?? [],
      };
    });

    const skipped: AutoScheduleSkip[] = [];
    const assignedCounts = new Map<string, { name: string; count: number }>();
    let assignedTotal = 0;

    for (const shift of openShifts) {
      // Wall-clock at the store, matching how associates enter availability.
      const shiftTz = shift.locationRel?.timezone ?? DEFAULT_TIMEZONE;
      const dow = zonedDayOfWeek(shift.startsAt, shiftTz);
      const startMin = zonedMinutes(shift.startsAt, shiftTz);
      const endMin = zonedMinutes(shift.endsAt, shiftTz);
      const shiftMinutes = Math.floor(
        (shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000,
      );

      const shiftDayStart = new Date(shift.startsAt);
      shiftDayStart.setUTCHours(0, 0, 0, 0);
      const shiftDayEnd = new Date(shift.endsAt);
      shiftDayEnd.setUTCHours(0, 0, 0, 0);

      type Scored = { state: AssocState; score: number };
      const scored: Scored[] = [];
      let everyoneOverOT = true;
      let anyEligible = false;

      for (const s of states) {
        // PTO is a hard veto — don't even consider this candidate.
        const onPto = s.pto.some(
          (p) => p.start <= shiftDayEnd && p.end >= shiftDayStart,
        );
        if (onPto) continue;

        // Conflict against any prior or just-added shift this week.
        const hasConflict = s.busy.some(
          (b) => b.startsAt < shift.endsAt && b.endsAt > shift.startsAt,
        );
        if (hasConflict) continue;

        anyEligible = true;
        const wouldExceed40 = s.weeklyMinutes + shiftMinutes > 40 * 60;
        if (wouldExceed40) continue;
        everyoneOverOT = false;

        const matchesAvailability = s.availability.some(
          (w) =>
            w.dayOfWeek === dow &&
            w.startMinute <= startMin &&
            w.endMinute >= endMin,
        );

        // Mirror the per-shift scorer, then break ties with whoever has
        // FEWER weekly minutes — keeps load balanced across the team.
        let score = 0;
        if (matchesAvailability) score += 0.5;
        score += 0.3; // no conflict (already filtered)
        score += 0.2; // not over 40h (already filtered)
        // Tiebreak: prefer the lighter-loaded associate. Multiply by a
        // small factor so it never beats a real signal but always beats
        // alphabetical / insertion order.
        score += (1 - s.weeklyMinutes / (40 * 60)) * 0.05;

        scored.push({ state: s, score });
      }

      if (scored.length === 0) {
        if (anyEligible && everyoneOverOT) {
          skipped.push({
            shiftId: shift.id,
            reason: 'all_candidates_overtime',
            detail: 'Every available associate would cross 40h this week.',
          });
        } else {
          skipped.push({
            shiftId: shift.id,
            reason: 'no_eligible_candidate',
            detail: 'No associate is available without a conflict or approved time off.',
          });
        }
        continue;
      }

      scored.sort((a, b) => b.score - a.score);
      const winner = scored[0].state;

      // Guarded claim: only assign if the shift is STILL open + unassigned.
      // A concurrent manual assign/cancel between the initial fetch and now
      // would otherwise be silently overwritten (TOCTOU).
      const claim = await prisma.shift.updateMany({
        where: { id: shift.id, status: 'OPEN', assignedAssociateId: null },
        data: {
          status: 'ASSIGNED',
          assignedAssociateId: winner.id,
          assignedAt: new Date(),
        },
      });
      if (claim.count === 0) {
        skipped.push({
          shiftId: shift.id,
          reason: 'no_eligible_candidate',
          detail: 'Shift was changed by someone else during auto-schedule; left as-is.',
        });
        continue;
      }
      await recordShiftEvent({
        actorUserId: req.user!.id,
        action: 'shift.updated',
        shiftId: shift.id,
        clientId: shift.clientId,
        metadata: {
          fields: ['status', 'assignedAssociateId'],
          autoFill: 'week',
          associateId: winner.id,
        },
        req,
      });

      // Mutate in-memory state so the next iteration sees this assignment.
      winner.busy.push({ startsAt: shift.startsAt, endsAt: shift.endsAt });
      winner.weeklyMinutes += shiftMinutes;
      assignedTotal += 1;
      const prev = assignedCounts.get(winner.id);
      if (prev) prev.count += 1;
      else assignedCounts.set(winner.id, { name: winner.name, count: 1 });
    }

    const byAssociate = Array.from(assignedCounts.entries())
      .map(([associateId, { name, count }]) => ({
        associateId,
        associateName: name,
        shiftsAssigned: count,
      }))
      .sort((a, b) => b.shiftsAssigned - a.shiftsAssigned);

    const body: AutoScheduleWeekResponse = {
      assigned: assignedTotal,
      skipped,
      byAssociate,
    };
    res.json(AutoScheduleWeekResponseSchema.parse(body));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /scheduling/export.pdf
 * Body: { from: ISO, to: ISO (exclusive), clientId? }
 *
 * Phase 54.4 — chronological PDF of every shift in the range, scoped per
 * the caller's role (HR sees all, CLIENT_PORTAL sees its own client only).
 * Streams application/pdf so the browser triggers a download.
 */
schedulingRouter.post('/export.pdf', MANAGE, async (req, res, next) => {
  try {
    const parsed = ScheduleExportInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (to <= from) {
      throw new HttpError(400, 'invalid_range', 'to must be after from');
    }

    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      startsAt: { gte: from, lt: to },
      ...(parsed.data.clientId ? { clientId: parsed.data.clientId } : {}),
    };
    const rows = await prisma.shift.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      include: SHIFT_INCLUDE,
      take: SCHEDULE_PDF_MAX_ROWS,
    });
    if (rows.length === SCHEDULE_PDF_MAX_ROWS) {
      // Signal truncation so the UI can show "showing first 5000 of N+".
      // We deliberately ship the partial PDF rather than 413 — a partial
      // schedule export is more useful than an error, and the header
      // gives ops a way to spot when the cap is being hit at scale.
      res.setHeader('X-Truncated', 'true');
      res.setHeader('X-Truncated-Limit', String(SCHEDULE_PDF_MAX_ROWS));
    }

    let clientName: string | null = null;
    if (parsed.data.clientId) {
      const c = await prisma.client.findFirst({
        where: { id: parsed.data.clientId, deletedAt: null },
        select: { name: true },
      });
      clientName = c?.name ?? null;
    }

    const pdf = await renderSchedulePdf({
      rangeFrom: from,
      rangeTo: to,
      generatedAt: new Date(),
      // Header stamp timezone: the first shift's site, else the deployment
      // default. Per-row times each use their own site timezone.
      timezone: rows[0]?.locationRel?.timezone ?? DEFAULT_TIMEZONE,
      filters: { clientName },
      shifts: rows.map((r) => ({
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        position: r.position,
        clientName: r.client?.name ?? null,
        location: r.location,
        // Render each row's date/time in its own work-site timezone so the
        // printed schedule shows store-local times, not the server's UTC.
        timezone: r.locationRel?.timezone ?? DEFAULT_TIMEZONE,
        assignedAssociateName: r.assignedAssociate
          ? `${r.assignedAssociate.firstName} ${r.assignedAssociate.lastName}`
          : null,
        status: r.status,
        hourlyRate: r.hourlyRate ? Number(r.hourlyRate) : null,
        scheduledMinutes: scheduledMinutes(r),
      })),
    });

    const fname = `shifts-${from.toISOString().slice(0, 10)}-to-${new Date(
      to.getTime() - 1
    )
      .toISOString()
      .slice(0, 10)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});
