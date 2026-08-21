// Shared walk-in approval — the one-tap "Approve all" quick action uses
// the SAME semantics as the single-approve route in routes/time.ts
// (backdated entry, re-matched shift, audit, associate notification).
// Keep the two in lockstep: any rule added there belongs here.

import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { recordTimeEvent } from './audit.js';
import { matchShiftForPunch } from './matchShiftForPunch.js';
import { notifyAssociate } from './notify.js';
import { DEFAULT_TIMEZONE, formatTimeInZone } from './timezone.js';

const MAX_AGE_MS = 14 * 3_600_000;

export type WalkInApprovalResult =
  | { ok: true; timeEntryId: string }
  | { ok: false; reason: 'not_pending' | 'too_old' | 'already_clocked_in' };

export async function approveWalkInRequest(
  prisma: PrismaClient,
  requestId: string,
  actorUserId: string,
  req?: Request,
): Promise<WalkInApprovalResult> {
  const request = await prisma.clockInRequest.findUnique({ where: { id: requestId } });
  if (!request || request.status !== 'PENDING') return { ok: false, reason: 'not_pending' };
  if (Date.now() - request.requestedAt.getTime() > MAX_AGE_MS) {
    return { ok: false, reason: 'too_old' };
  }
  const open = await prisma.timeEntry.findFirst({
    where: { associateId: request.associateId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (open) return { ok: false, reason: 'already_clocked_in' };

  const entry = await prisma.$transaction(async (tx) => {
    const created = await tx.timeEntry.create({
      data: {
        associateId: request.associateId,
        clientId: request.clientId,
        locationId: request.locationId,
        shiftId: await matchShiftForPunch(tx, request.associateId, request.requestedAt),
        clockInAt: request.requestedAt,
        status: 'ACTIVE',
      },
    });
    await tx.clockInRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        decidedById: actorUserId,
        decidedAt: new Date(),
        timeEntryId: created.id,
      },
    });
    return created;
  });

  await recordTimeEvent({
    actorUserId,
    action: 'time.clock_in_request_approved',
    timeEntryId: entry.id,
    associateId: request.associateId,
    metadata: {
      clockInRequestId: request.id,
      backdatedTo: request.requestedAt.toISOString(),
      via: 'quick_action',
    },
    req,
  });
  void notifyAssociate(request.associateId, {
    subject: "You're clocked in",
    body: `Your supervisor approved your clock-in — you are on the clock as of ${formatTimeInZone(request.requestedAt, DEFAULT_TIMEZONE)}. No need to punch again; clock out at the kiosk as usual.`,
    category: 'time_entry',
    linkUrl: '/time-attendance',
  });
  return { ok: true, timeEntryId: entry.id };
}
