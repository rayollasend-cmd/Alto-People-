import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { scopeShifts } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { eligibleOpenShifts } from '../lib/openShiftEligibility.js';
import { declineOpenShift, inviteCountsFor, rebroadcastOpenShift, undoDeclineOpenShift } from '../lib/openShiftInvites.js';

/**
 * Open-shift invitations (role walk, ops 11; lib/openShiftInvites).
 *
 *   GET    /open-shifts/invite-counts          sent / declined per open shift in the caller's reach
 *   POST   /open-shifts/:shiftId/rebroadcast   ask the eligible bench again
 *   POST   /open-shifts/:shiftId/decline       the associate's "Not for me"
 *   DELETE /open-shifts/:shiftId/decline       undo it
 */
export const openShiftInvitesRouter = Router();

const MANAGE = requireCapability('manage:scheduling');
const VIEW = requireCapability('view:scheduling');
const DAY_MS = 86_400_000;

const CountsQuery = z.object({
  shiftIds: z
    .string()
    .trim()
    .max(20_000)
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.string().uuid()).max(500).optional()),
  days: z.coerce.number().int().min(1).max(60).default(14),
});

openShiftInvitesRouter.get('/open-shifts/invite-counts', MANAGE, async (req, res) => {
  const parsed = CountsQuery.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, 'invalid_query', 'Invalid query', parsed.error.flatten());
  const now = new Date();
  // The open shifts the caller may see — their reach, this tenant — and only those.
  const shifts = await prisma.shift.findMany({
    where: {
      AND: [
        {
          tenantId: tenantIdForWrite(),
          status: 'OPEN',
          assignedAssociateId: null,
          publishedAt: { not: null },
          endsAt: { gt: now },
          startsAt: { lt: new Date(now.getTime() + parsed.data.days * DAY_MS) },
          ...(parsed.data.shiftIds ? { id: { in: parsed.data.shiftIds } } : {}),
        },
        scopeShifts(req.user!),
      ],
    },
    select: { id: true },
    orderBy: { startsAt: 'asc' },
    take: 500,
  });
  const counts = await inviteCountsFor(prisma, shifts.map((s) => s.id));
  res.json({ counts: [...counts.values()] });
});

openShiftInvitesRouter.post('/open-shifts/:shiftId/rebroadcast', MANAGE, async (req, res) => {
  const user = req.user!;
  const shiftId = z.string().uuid().safeParse(req.params.shiftId);
  if (!shiftId.success) throw new HttpError(404, 'shift_not_found', 'Shift not found.');
  const shift = await prisma.shift.findFirst({
    where: { AND: [{ id: shiftId.data, tenantId: tenantIdForWrite() }, scopeShifts(user)] },
    select: { id: true, clientId: true },
  });
  if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found.');
  const result = await rebroadcastOpenShift(prisma, shift.id);
  if ('refused' in result) {
    const why = {
      not_open: 'This shift is no longer open.',
      started: 'This shift has already started.',
      no_bench: 'This shift names no client or store, so it has no bench to ask.',
    }[result.refused];
    throw new HttpError(409, `shift_${result.refused}`, why);
  }
  enqueueAudit(
    {
      actorUserId: user.id,
      clientId: shift.clientId,
      action: 'shift.rebroadcast',
      entityType: 'Shift',
      entityId: shift.id,
      metadata: { sent: result.sent, held: result.held, skipped: result.skipped },
    },
    'openShifts.rebroadcast',
  );
  res.json(result);
});

/** An associate may pass on a shift they were asked about or could pick up. */
async function assertMayDecline(associateId: string, shiftId: string): Promise<void> {
  const invited = await prisma.openShiftInvite.findUnique({ where: { shiftId_associateId: { shiftId, associateId } }, select: { id: true } });
  if (invited) return;
  const eligible = await eligibleOpenShifts(associateId, { shiftIds: [shiftId] });
  if (eligible.length === 0) throw new HttpError(404, 'shift_not_available', 'This shift is no longer open');
}

openShiftInvitesRouter.post('/open-shifts/:shiftId/decline', VIEW, async (req, res) => {
  const associateId = req.user?.associateId;
  if (!associateId) throw new HttpError(403, 'no_associate_link', 'Only an associate can pass on a shift.');
  const shiftId = z.string().uuid().safeParse(req.params.shiftId);
  if (!shiftId.success) throw new HttpError(404, 'shift_not_available', 'This shift is no longer open');
  await assertMayDecline(associateId, shiftId.data);
  await declineOpenShift(prisma, shiftId.data, associateId);
  res.json({ ok: true });
});

openShiftInvitesRouter.delete('/open-shifts/:shiftId/decline', VIEW, async (req, res) => {
  const associateId = req.user?.associateId;
  if (!associateId) throw new HttpError(403, 'no_associate_link', 'Only an associate can pass on a shift.');
  const shiftId = z.string().uuid().safeParse(req.params.shiftId);
  if (!shiftId.success) throw new HttpError(404, 'shift_not_available', 'This shift is no longer open');
  await undoDeclineOpenShift(prisma, shiftId.data, associateId);
  res.json({ ok: true });
});
