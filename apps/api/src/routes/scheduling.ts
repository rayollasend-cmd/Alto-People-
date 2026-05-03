import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  AssociateListResponseSchema,
  AutoFillResponseSchema,
  AutoScheduleWeekInputSchema,
  AutoScheduleWeekResponseSchema,
  AvailabilityListResponseSchema,
  AvailabilityReplaceInputSchema,
  CalendarFeedUrlResponseSchema,
  CopyWeekInputSchema,
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
  SwapCreateInputSchema,
  SwapDecideInputSchema,
  type AutoFillCandidate,
  type AutoScheduleSkip,
  type AutoScheduleWeekResponse,
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
import { enqueueAudit, recordShiftEvent } from '../lib/audit.js';
import { formatShiftLine, notifyShift } from '../lib/notifyShift.js';
import { notifyManager } from '../lib/notify.js';
import { shiftSwapManagerTemplate } from '../lib/emailTemplates.js';
import { netWorkedMinutes, startOfWeekUTC, endOfWeekUTC } from '../lib/timeAnomalies.js';
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
// system) and terminated/uninvited people. Schedulable pool = associates
// whose linked User row is ACTIVE and has the ASSOCIATE role specifically
// — excludes MANAGER, OPERATIONS_MANAGER, HR_*, CLIENT_PORTAL, etc., and
// also excludes anyone INVITED-but-not-yet-accepted or DISABLED.
const ACTIVE_ASSOCIATE_FILTER: Prisma.AssociateWhereInput = {
  deletedAt: null,
  user: { is: { status: 'ACTIVE', role: 'ASSOCIATE' } },
};

type RawShift = Prisma.ShiftGetPayload<{
  include: {
    client: { select: { name: true } };
    assignedAssociate: { select: { firstName: true; lastName: true } };
  };
}>;

function scheduledMinutes(row: { startsAt: Date; endsAt: Date }): number {
  return Math.max(0, Math.floor((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000));
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
    assignedAssociateId: row.assignedAssociateId,
    assignedAssociateName: row.assignedAssociate
      ? `${row.assignedAssociate.firstName} ${row.assignedAssociate.lastName}`
      : null,
    assignedAt: row.assignedAt ? row.assignedAt.toISOString() : null,
    cancellationReason: row.cancellationReason,
    scheduledMinutes: scheduledMinutes(row),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    lateNoticeReason: row.lateNoticeReason,
  };
}

const SHIFT_INCLUDE = {
  client: { select: { name: true } },
  assignedAssociate: { select: { firstName: true, lastName: true } },
} as const;

/* ===== HR/Ops list + CRUD =============================================== */

schedulingRouter.get('/shifts', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const clientId = req.query.clientId?.toString();
    const from = req.query.from?.toString();
    const to = req.query.to?.toString();

    const where: Prisma.ShiftWhereInput = {
      ...scopeShifts(req.user!),
      ...(status ? { status: status as Prisma.ShiftWhereInput['status'] } : {}),
      ...(clientId ? { clientId } : {}),
      ...(from || to
        ? {
            startsAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };

    const rows = await prisma.shift.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: 200,
      include: SHIFT_INCLUDE,
    });
    const payload = ShiftListResponseSchema.parse({ shifts: rows.map(toShift) });
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
    // two rate columns and roll up.
    const rows = await prisma.shift.findMany({
      where,
      select: { startsAt: true, endsAt: true, payRate: true },
    });
    let totalScheduledMinutes = 0;
    let projectedLaborCost = 0;
    let shiftsWithoutRate = 0;
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
schedulingRouter.get('/associates', MANAGE, async (_req, res, next) => {
  try {
    const rows = await prisma.associate.findMany({
      where: ACTIVE_ASSOCIATE_FILTER,
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
    }

    const updated = await prisma.shift.update({
      where: { id: existing.id },
      data,
      include: SHIFT_INCLUDE,
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

    const updated = await prisma.shift.update({
      where: { id: shift.id },
      data: {
        assignedAssociateId: associate.id,
        assignedAt: new Date(),
        status: 'ASSIGNED',
      },
      include: SHIFT_INCLUDE,
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

schedulingRouter.get('/me/shifts', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      const empty: ShiftListResponse = { shifts: [] };
      res.json(empty);
      return;
    }
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
      },
      orderBy: { startsAt: 'asc' },
      take: 100,
      include: SHIFT_INCLUDE,
    });
    res.json({ shifts: rows.map(toShift) } satisfies ShiftListResponse);
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
schedulingRouter.get('/me/calendar-url', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(404, 'no_associate', 'No associate profile linked');
    }
    const token = mintCalendarToken(user.associateId);
    // APP_BASE_URL is the web app origin in dev; in prod the API and SPA
    // share an origin (Railway single-service setup), so this works for
    // both. The `/api/calendar/v1/...` prefix matches the prod proxy path
    // — in dev the SPA proxies `/api/*` to the API.
    const base = env.APP_BASE_URL.replace(/\/$/, '');
    const path = `/api/calendar/v1/${user.associateId}/${token}.ics`;
    const url = `${base}${path}`;
    const webcalUrl = url.replace(/^https?:\/\//, 'webcal://');
    res.json(
      CalendarFeedUrlResponseSchema.parse({ url, webcalUrl }),
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
    });
    if (!target) throw new HttpError(404, 'shift_not_found', 'Shift not found');

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
        where: {
          status: 'APPROVED',
          startDate: { lte: targetDayEnd },
          endDate: { gte: targetDayStart },
        },
        select: { associateId: true },
      }),
    ]);

    const ptoAssociateIds = new Set(ptoRows.map((r) => r.associateId));

    const targetDOW = target.startsAt.getUTCDay();
    const startMin = target.startsAt.getUTCHours() * 60 + target.startsAt.getUTCMinutes();
    const endMin = target.endsAt.getUTCHours() * 60 + target.endsAt.getUTCMinutes();

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
    shift: { include: { client: { select: { name: true } } } };
    requester: { select: { firstName: true; lastName: true } };
    counterparty: { select: { firstName: true; lastName: true } };
  };
}>;

const SWAP_INCLUDE = {
  shift: { include: { client: { select: { name: true } } } },
  requester: { select: { firstName: true, lastName: true } },
  counterparty: { select: { firstName: true, lastName: true } },
} as const;

function toSwap(row: RawSwap): ShiftSwapRequestDTO {
  return {
    id: row.id,
    shiftId: row.shiftId,
    shiftStartsAt: row.shift.startsAt.toISOString(),
    shiftEndsAt: row.shift.endsAt.toISOString(),
    shiftPosition: row.shift.position,
    shiftClientName: row.shift.client?.name ?? null,
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
    const { shiftId, counterpartyAssociateId, note } = parsed.data;

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

    const created = await prisma.shiftSwapRequest.create({
      data: {
        shiftId,
        requesterAssociateId: user.associateId,
        counterpartyAssociateId,
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

schedulingRouter.get('/swap-requests/me/incoming', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json(ShiftSwapListResponseSchema.parse({ requests: [] }));
      return;
    }
    const rows = await prisma.shiftSwapRequest.findMany({
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
    const updated = await prisma.shiftSwapRequest.update({
      where: { id: swap.id },
      data: { status: 'PEER_ACCEPTED' },
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
    const updated = await prisma.shiftSwapRequest.update({
      where: { id: swap.id },
      data: { status: 'PEER_DECLINED' },
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
    const updated = await prisma.shiftSwapRequest.update({
      where: { id: swap.id },
      data: { status: 'CANCELLED' },
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
    const swap = await prisma.shiftSwapRequest.findUnique({
      where: { id: req.params.id },
      include: { shift: true },
    });
    if (!swap) throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    if (swap.status !== 'PEER_ACCEPTED') {
      throw new HttpError(
        409,
        'not_peer_accepted',
        'Counterparty must accept the swap before HR approval'
      );
    }

    // Execute the swap atomically: shift assignment flips, status flips.
    await prisma.$transaction([
      prisma.shift.update({
        where: { id: swap.shiftId },
        data: {
          assignedAssociateId: swap.counterpartyAssociateId,
          assignedAt: new Date(),
        },
      }),
      prisma.shiftSwapRequest.update({
        where: { id: swap.id },
        data: { status: 'MANAGER_APPROVED', decidedById: user.id, decidedAt: new Date() },
      }),
    ]);

    await recordShiftEvent({
      actorUserId: user.id,
      action: 'shift.swapped',
      shiftId: swap.shiftId,
      clientId: swap.shift.clientId,
      metadata: {
        from: swap.requesterAssociateId,
        to: swap.counterpartyAssociateId,
        swapRequestId: swap.id,
      },
      req,
    });

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
    });
    await notifyShift(prisma, {
      associateId: updated.counterpartyAssociateId,
      subject: 'Swap approved — shift is yours',
      body: `HR approved the swap. You're now scheduled for: ${shiftLine}`,
      category: 'swap_manager_approved',
      senderUserId: req.user!.id,
    });
    await notifyShift(prisma, {
      associateId: updated.requesterAssociateId,
      subject: 'Swap approved — shift handed off',
      body: `HR approved your swap with ${updated.counterparty.firstName} ${updated.counterparty.lastName}. You're off this shift: ${shiftLine}`,
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
    const swap = await prisma.shiftSwapRequest.findUnique({ where: { id: req.params.id } });
    if (!swap) throw new HttpError(404, 'swap_not_found', 'Swap request not found');
    if (swap.status === 'MANAGER_APPROVED' || swap.status === 'MANAGER_REJECTED' || swap.status === 'CANCELLED') {
      throw new HttpError(409, 'invalid_state', `Swap is in ${swap.status}, cannot reject`);
    }
    const updated = await prisma.shiftSwapRequest.update({
      where: { id: swap.id },
      data: { status: 'MANAGER_REJECTED', decidedById: user.id, decidedAt: new Date() },
      include: SWAP_INCLUDE,
    });

    // Notify both parties so the requester knows to find another solution
    // and the counterparty isn't left wondering.
    const shiftLine = formatShiftLine({
      position: updated.shift.position,
      clientName: updated.shift.client?.name ?? null,
      startsAt: updated.shift.startsAt,
      endsAt: updated.shift.endsAt,
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
    const sourceShifts = await prisma.shift.findMany({ where });
    if (sourceShifts.length === 0) {
      const empty: CopyWeekResponse = { created: 0, skipped: 0 };
      res.json(empty);
      return;
    }

    const offsetMs = target.getTime() - source.getTime();
    const data = sourceShifts.map((s) => ({
      clientId: s.clientId,
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
      where,
      include: {
        client: { select: { state: true, name: true } },
        assignedAssociate: { select: { firstName: true, lastName: true } },
      },
    });

    const now = new Date();
    const skipped: PublishWeekSkip[] = [];
    const publishable: typeof drafts = [];

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
      publishable.push(s);
    }

    // Bucket publishable shifts by assignee so we can send ONE digest
    // notification per associate at the end. Without this, a person with
    // five shifts in the published week would get five push pings — fine
    // for a single change, spammy on a batch publish.
    const perAssociate = new Map<string, typeof publishable>();
    let publishedCount = 0;
    for (const s of publishable) {
      const nextStatus = s.assignedAssociateId ? 'ASSIGNED' : 'OPEN';
      await prisma.shift.update({
        where: { id: s.id },
        data: { status: nextStatus, publishedAt: now },
      });
      await recordShiftEvent({
        actorUserId: req.user!.id,
        action: 'shift.updated',
        shiftId: s.id,
        clientId: s.clientId,
        metadata: { fields: ['status', 'publishedAt'], publish: 'week' },
        req,
      });
      if (s.assignedAssociateId) {
        const bucket = perAssociate.get(s.assignedAssociateId) ?? [];
        bucket.push(s);
        perAssociate.set(s.assignedAssociateId, bucket);
      }
      publishedCount += 1;
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

    const [associates, ptoRows] = await Promise.all([
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
        where: {
          status: 'APPROVED',
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { associateId: true, startDate: true, endDate: true },
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
      const dow = shift.startsAt.getUTCDay();
      const startMin = shift.startsAt.getUTCHours() * 60 + shift.startsAt.getUTCMinutes();
      const endMin = shift.endsAt.getUTCHours() * 60 + shift.endsAt.getUTCMinutes();
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

      await prisma.shift.update({
        where: { id: shift.id },
        data: {
          status: 'ASSIGNED',
          assignedAssociateId: winner.id,
          assignedAt: new Date(),
        },
      });
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
      // PDF is page-broken — we don't need the list-view 200 cap here.
      take: 5000,
    });

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
      filters: { clientName },
      shifts: rows.map((r) => ({
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        position: r.position,
        clientName: r.client?.name ?? null,
        location: r.location,
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
