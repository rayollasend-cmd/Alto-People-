import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  AutoFillResponseSchema,
  AvailabilityListResponseSchema,
  AvailabilityReplaceInputSchema,
  ShiftAssignInputSchema,
  ShiftCancelInputSchema,
  ShiftConflictsResponseSchema,
  ShiftCreateInputSchema,
  ShiftListResponseSchema,
  ShiftSwapListResponseSchema,
  ShiftUpdateInputSchema,
  SwapCreateInputSchema,
  SwapDecideInputSchema,
  type AutoFillCandidate,
  type AvailabilityWindow,
  type Shift,
  type ShiftConflict,
  type ShiftListResponse,
  type ShiftSwapRequest as ShiftSwapRequestDTO,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeShifts } from '../lib/scope.js';
import { recordShiftEvent } from '../lib/audit.js';
import { netWorkedMinutes, startOfWeekUTC, endOfWeekUTC } from '../lib/timeAnomalies.js';
import {
  evaluateShiftNotice,
  isPublishingTransition,
} from '../lib/predictiveScheduling.js';

export const schedulingRouter = Router();

const MANAGE = requireCapability('manage:scheduling');

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

    const overlaps = await prisma.shift.findMany({
      where: {
        assignedAssociateId: associateId,
        id: { not: target.id },
        status: { notIn: ['CANCELLED', 'COMPLETED'] },
        // Standard overlap: existing.starts < target.ends AND existing.ends > target.starts
        startsAt: { lt: target.endsAt },
        endsAt: { gt: target.startsAt },
      },
      include: {
        client: { select: { name: true } },
      },
    });

    const conflicts: ShiftConflict[] = overlaps.map((s) => ({
      conflictingShiftId: s.id,
      conflictingStartsAt: s.startsAt.toISOString(),
      conflictingEndsAt: s.endsAt.toISOString(),
      conflictingClientName: s.client?.name ?? null,
      conflictingPosition: s.position,
    }));
    res.json(ShiftConflictsResponseSchema.parse({ conflicts }));
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

    const associates = await prisma.associate.findMany({
      where: { deletedAt: null },
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
    });

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

      return {
        associateId: a.id,
        associateName: `${a.firstName} ${a.lastName}`,
        weeklyMinutesScheduled,
        weeklyMinutesActual,
        matchesAvailability,
        noConflict,
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
    res.json(toSwap(updated));
  } catch (err) {
    next(err);
  }
});
