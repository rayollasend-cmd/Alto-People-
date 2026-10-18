import { Router } from 'express';
import { z } from 'zod';
import type { CallOutReason } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireAuth, requireCapability } from '../middleware/auth.js';
import { assertAssociateInScope, scopeActiveAssociates } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import {
  CALL_OUT_TEXT,
  CallOutError,
  coverStateOf,
  placeOf,
  recordCallOut,
  toCallOutLang,
  whenLabel,
  zoneOf,
} from '../lib/callOuts.js';

/**
 * Call-outs (lib/callOuts).
 *
 *   POST /me/call-outs     { shiftId, reason, note? } — "I can't make it" on the shift card
 *   GET  /me/call-outs     the worker's own call-outs in the coming days (so the card says so)
 *   GET  /call-outs        today's and tomorrow's call-outs within reach, with how cover is going
 *   POST /call-outs        { associateId, shiftId, reason, note? } — a lead records one taken by phone
 */

export const callOutsRouter = Router();

const REASONS = ['SICK', 'FAMILY', 'TRANSPORT', 'EMERGENCY', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER'] as const;

const MineBody = z.object({
  shiftId: z.string().uuid(),
  reason: z.enum(REASONS),
  note: z.string().trim().max(1000).optional(),
});

const StaffBody = MineBody.extend({ associateId: z.string().uuid() });

function asHttp(err: unknown): never {
  if (err instanceof CallOutError) {
    throw new HttpError(err.code === 'shift_not_found' || err.code === 'not_your_shift' ? 404 : 409, err.code, err.message);
  }
  throw err;
}

callOutsRouter.post('/me/call-outs', requireAuth, async (req, res) => {
  const user = req.user!;
  if (!user.associateId) throw new HttpError(403, 'not_a_worker', 'Only a worker can call out of their own shift.');
  const body = MineBody.parse(req.body ?? {});
  const result = await recordCallOut({ associateId: user.associateId, shiftId: body.shiftId, channel: 'APP', reason: body.reason as CallOutReason, note: body.note ?? null, confirm: true }).catch(asHttp);
  const lang = toCallOutLang(user.language);
  const tz = zoneOf(result.shift);
  const when = whenLabel(result.shift.startsAt, tz, lang);
  res.status(result.outcome === 'duplicate' ? 200 : 201).json({
    callOutId: result.callOutId,
    outcome: result.outcome,
    message: result.outcome === 'duplicate' ? CALL_OUT_TEXT.already(lang, when) : CALL_OUT_TEXT.confirmed(lang, placeOf(result.shift), when),
  });
});

callOutsRouter.get('/me/call-outs', requireAuth, async (req, res) => {
  const user = req.user!;
  if (!user.associateId) {
    res.json({ callOuts: [] });
    return;
  }
  const rows = await prisma.callOut.findMany({
    where: { tenantId: tenantIdForWrite(), associateId: user.associateId, status: 'CONFIRMED', shift: { startsAt: { gte: new Date(Date.now() - 12 * 3_600_000) } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, shiftId: true, reason: true, createdAt: true, shift: { select: { position: true, startsAt: true, locationRel: { select: { name: true, timezone: true } }, client: { select: { name: true } } } } },
  });
  res.json({
    callOuts: rows.map((r) => ({
      id: r.id,
      shiftId: r.shiftId,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      position: r.shift.position,
      startsAt: r.shift.startsAt.toISOString(),
      place: r.shift.locationRel?.name ?? r.shift.client?.name ?? null,
      timezone: r.shift.locationRel?.timezone ?? null,
    })),
  });
});

const ListQuery = z.object({ range: z.enum(['today', 'week']).default('today') });

callOutsRouter.get('/call-outs', requireAnyCapability('manage:scheduling', 'view:scheduling'), async (req, res) => {
  const user = req.user!;
  // A worker reads their own at /me/call-outs; a store's portal account is not a lead's desk.
  if (user.role === 'ASSOCIATE' || user.role === 'CLIENT_PORTAL') throw new HttpError(403, 'forbidden', 'Call-outs are for the people who lead the floor.');
  const { range } = ListQuery.parse(req.query);
  const now = new Date();
  const from = new Date(now.getTime() - 12 * 3_600_000);
  const to = new Date(now.getTime() + (range === 'week' ? 7 * 24 : 36) * 3_600_000);
  const rows = await prisma.callOut.findMany({
    where: {
      AND: [
        { tenantId: tenantIdForWrite(), status: 'CONFIRMED', shift: { startsAt: { gte: from, lte: to } } },
        // Everyone the caller may see — a lead their floor, a regional manager their sites.
        { associate: scopeActiveAssociates(user, { former: true }) },
      ],
    },
    orderBy: { shift: { startsAt: 'asc' } },
    take: 500,
    select: {
      id: true,
      associateId: true,
      channel: true,
      reason: true,
      note: true,
      late: true,
      excused: true,
      excusedWhy: true,
      minutesBeforeStart: true,
      recordingUrl: true,
      coverSteps: true,
      createdAt: true,
      associate: { select: { firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true } },
      shift: {
        select: {
          id: true,
          position: true,
          startsAt: true,
          endsAt: true,
          status: true,
          assignedAssociateId: true,
          locationRel: { select: { name: true, timezone: true } },
          client: { select: { name: true } },
          assignedAssociate: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });
  const items = rows.map((r) => {
    const state = coverStateOf(r, now);
    return {
      id: r.id,
      associateId: r.associateId,
      name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
      photoUrl: r.associate.photoS3Key ? `/api/associates/${r.associateId}/photo?v=${r.associate.photoUpdatedAt?.getTime() ?? 0}` : null,
      channel: r.channel,
      reason: r.reason,
      note: r.note,
      late: r.late,
      excused: r.excused,
      excusedWhy: r.excusedWhy,
      minutesBeforeStart: r.minutesBeforeStart,
      hasRecording: !!r.recordingUrl,
      calledOutAt: r.createdAt.toISOString(),
      shift: {
        id: r.shift.id,
        position: r.shift.position,
        startsAt: r.shift.startsAt.toISOString(),
        endsAt: r.shift.endsAt.toISOString(),
        place: r.shift.locationRel?.name ?? r.shift.client?.name ?? null,
        timezone: r.shift.locationRel?.timezone ?? null,
      },
      cover: {
        state,
        by: state === 'covered' && r.shift.assignedAssociate ? `${r.shift.assignedAssociate.firstName} ${r.shift.assignedAssociate.lastName}`.trim() : null,
        steps: (r.coverSteps as Array<{ key: string; status: string; detail: string }> | null) ?? [],
      },
    };
  });
  res.json({
    range,
    total: items.length,
    covered: items.filter((i) => i.cover.state === 'covered').length,
    looking: items.filter((i) => i.cover.state === 'looking').length,
    uncovered: items.filter((i) => i.cover.state === 'uncovered').length,
    late: items.filter((i) => i.late).length,
    truncated: rows.length === 500,
    items,
  });
});

callOutsRouter.post('/call-outs', requireCapability('manage:scheduling'), async (req, res) => {
  const user = req.user!;
  const body = StaffBody.parse(req.body ?? {});
  await assertAssociateInScope(prisma, user, body.associateId);
  const result = await recordCallOut({
    associateId: body.associateId,
    shiftId: body.shiftId,
    channel: 'STAFF',
    reason: body.reason as CallOutReason,
    note: body.note ?? null,
    createdById: user.id,
    confirm: true,
  }).catch(asHttp);
  res.status(result.outcome === 'duplicate' ? 200 : 201).json({ callOutId: result.callOutId, outcome: result.outcome, steps: result.steps });
});
