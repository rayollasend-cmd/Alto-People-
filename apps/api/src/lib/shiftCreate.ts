import type { Prisma, PrismaClient, ShiftStatus } from '@prisma/client';
import type { Request } from 'express';
import { MAX_SHIFT_WALL_MIN } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { recordShiftEvent } from './audit.js';
import { firstLocationForClient } from './firstLocationForClient.js';
import { maybeNotifyFinanceNewWorker } from './fieldglassNotify.js';
import { evaluateShiftNotice, isPublishingTransition } from './predictiveScheduling.js';
import { tenantIdForWrite } from './tenant.js';
import { formatShiftLine, notifyShift, shiftWa } from './notifyShift.js';
import { emitShiftEvent } from './webhookEvents.js';

/**
 * Creating a shift, under the schedule's rules — one copy for the session
 * route (POST /scheduling/shifts) and the public API (POST /v1/shifts,
 * Brief 2-4: "writes reuse the domain code the session routes call").
 *
 *   With a client, the site is one of the client's (or the client's first);
 *   without one (a direct employer) the shift names its site and carries no
 *   client. No shift spans more than the wall limit. Publishing inside a
 *   fair-workweek state's notice window needs a reason. The audit row names
 *   the person or the API client that created it.
 */

/**
 * A shift longer than the wall limit is a data error (an end date rolled a
 * day too far), refused at every write path, never stored and discovered.
 */
export function assertSaneShiftDuration(startsAt: Date, endsAt: Date): void {
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (minutes > MAX_SHIFT_WALL_MIN) {
    throw new HttpError(
      400,
      'shift_too_long',
      `A shift can't span ${(minutes / 60).toFixed(1)} hours (max ${MAX_SHIFT_WALL_MIN / 60}h). Check the end date — it's probably rolled a day too far.`,
    );
  }
}

export interface ShiftCreateFields {
  clientId?: string | null;
  locationId?: string | null;
  position: string;
  startsAt: string | Date;
  endsAt: string | Date;
  status?: ShiftStatus;
  lateNoticeReason?: string | null;
  location?: string | null;
  hourlyRate?: number | null;
  payRate?: number | null;
  notes?: string | null;
}

export interface ShiftCreateActor {
  userId: string | null;
  /** Brief 2-4: the API client creating it, when it is one. */
  apiClientId?: string | null;
  /** A site-only account schedules its own site and nowhere else. */
  ownSiteOnly?: string | null;
  /** The bill rate is not this actor's to set. */
  hideBillRate: boolean;
  req?: Request;
}

export async function createShiftWithinRules<I extends Prisma.ShiftInclude>(
  db: PrismaClient,
  input: ShiftCreateFields,
  actor: ShiftCreateActor,
  include: I,
): Promise<Prisma.ShiftGetPayload<{ include: I }>> {
  const tenantId = tenantIdForWrite();
  let client: { id: string; state: string | null } | null = null;
  let location: { id: string };
  let noticeState: string | null;
  if (input.clientId) {
    const found = await db.client.findFirst({ where: { id: input.clientId, tenantId, deletedAt: null }, select: { id: true, state: true } });
    if (!found) throw new HttpError(404, 'client_not_found', 'Client not found');
    client = found;
    noticeState = found.state;
    if (input.locationId) {
      const picked = await db.site.findFirst({ where: { id: input.locationId, clientId: client.id, tenantId, deletedAt: null, isActive: true }, select: { id: true } });
      if (!picked) throw new HttpError(400, 'location_mismatch', 'Location does not belong to the chosen client.');
      location = picked;
    } else {
      location = await firstLocationForClient(db, client.id);
    }
  } else {
    if (!input.locationId) throw new HttpError(400, 'site_required', 'Name the site for this shift.');
    const site = await db.site.findFirst({ where: { id: input.locationId, tenantId, deletedAt: null, isActive: true }, select: { id: true, clientId: true, state: true } });
    if (!site) throw new HttpError(404, 'location_not_found', 'Site not found.');
    if (site.clientId) throw new HttpError(400, 'client_required', 'This site belongs to a client; name the client.');
    if (actor.ownSiteOnly && actor.ownSiteOnly !== site.id) throw new HttpError(403, 'forbidden', 'You can only manage shifts at your own site.');
    location = site;
    noticeState = site.state;
  }

  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  assertSaneShiftDuration(startsAt, endsAt);
  const status = input.status ?? 'OPEN';
  const now = new Date();
  let lateNoticeReason: string | null = null;
  let publishedAt: Date | null = null;
  if (isPublishingTransition(undefined, status)) {
    const evaluation = evaluateShiftNotice({ state: noticeState, startsAt, publishAt: now });
    if (evaluation.requiresReason && !input.lateNoticeReason) {
      throw new HttpError(400, 'late_notice_reason_required', `Publishing a shift inside the 14-day notice window in ${evaluation.state} requires lateNoticeReason`);
    }
    lateNoticeReason = input.lateNoticeReason ?? null;
    publishedAt = now;
  }

  const created = await db.shift.create({
    data: {
      clientId: client?.id ?? null,
      locationId: location.id,
      position: input.position,
      startsAt,
      endsAt,
      location: input.location ?? null,
      hourlyRate: actor.hideBillRate ? null : (input.hourlyRate ?? null),
      payRate: input.payRate ?? null,
      notes: input.notes ?? null,
      status,
      createdById: actor.userId,
      publishedAt,
      lateNoticeReason,
    },
    include,
  });

  await recordShiftEvent({
    actorUserId: actor.userId,
    apiClientId: actor.apiClientId ?? null,
    action: 'shift.created',
    shiftId: created.id,
    clientId: created.clientId,
    metadata: { position: created.position, status: created.status, ...(lateNoticeReason ? { lateNoticeReason, lateNotice: true } : {}) },
    req: actor.req,
  });
  // A brand-new hire's first shift may arrive by direct creation: the Fieldglass handoff (deduped).
  if (created.assignedAssociateId) void maybeNotifyFinanceNewWorker(created.assignedAssociateId);
  emitShiftEvent(created.id, 'created');
  return created as Prisma.ShiftGetPayload<{ include: I }>;
}

/**
 * Cancelling a shift and everything it closes: live swap requests end (and
 * both people hear), and the person on a published shift is told, in
 * WhatsApp's template too. One copy for POST /scheduling/shifts/:id/cancel
 * and POST /v1/shifts/:id/cancel. The caller has found the shift in scope
 * and refused a completed one.
 */
export async function cancelShiftWithinRules<I extends Prisma.ShiftInclude & { client: { select: { name: true } }; locationRel: { select: { name: true; timezone: true } } }>(
  db: PrismaClient,
  shift: { id: string; assignedAssociateId: string | null; publishedAt: Date | null },
  reason: string,
  actor: { userId: string | null; apiClientId?: string | null; req?: Request },
  include: I,
): Promise<Prisma.ShiftGetPayload<{ include: I }>> {
  const updated = (await db.shift.update({
    where: { id: shift.id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason },
    include,
  })) as Prisma.ShiftGetPayload<{ include: I }> & { client: { name: string } | null; locationRel: { name: string; timezone: string } | null };

  await recordShiftEvent({
    actorUserId: actor.userId,
    apiClientId: actor.apiClientId ?? null,
    action: 'shift.cancelled',
    shiftId: updated.id,
    clientId: updated.clientId,
    metadata: { reason },
    req: actor.req,
  });

  const line = formatShiftLine({ position: updated.position, clientName: updated.client?.name ?? null, startsAt: updated.startsAt, endsAt: updated.endsAt, timezone: updated.locationRel?.timezone ?? null });
  // In-flight swaps have nothing left to swap: close them, or the counterparty could still "accept" a dead shift.
  const liveSwaps = await db.shiftSwapRequest.findMany({
    where: { shiftId: shift.id, status: { in: ['PENDING_PEER', 'PEER_ACCEPTED'] } },
    select: { id: true, requesterAssociateId: true, counterpartyAssociateId: true },
  });
  if (liveSwaps.length > 0) {
    await db.shiftSwapRequest.updateMany({ where: { id: { in: liveSwaps.map((x) => x.id) } }, data: { status: 'CANCELLED' } });
    const notified = new Set<string>();
    for (const sw of liveSwaps) {
      for (const aid of [sw.requesterAssociateId, sw.counterpartyAssociateId]) {
        if (aid && !notified.has(aid)) {
          notified.add(aid);
          void notifyShift(db, { associateId: aid, subject: 'Swap cancelled', body: `A swap you were part of is off — the shift was cancelled. ${line}`, category: 'swap_manager_rejected', senderUserId: actor.userId });
        }
      }
    }
  }
  emitShiftEvent(updated.id, 'cancelled');
  // A never-published shift is invisible to the person on it: no notice.
  if (shift.assignedAssociateId && shift.publishedAt) {
    void notifyShift(db, {
      associateId: shift.assignedAssociateId,
      subject: 'Shift cancelled',
      body: `Cancelled: ${line}\nReason: ${reason}`,
      category: 'shift_cancelled',
      senderUserId: actor.userId,
      wa: shiftWa('alto_shift_cancelled', { position: updated.position, clientName: updated.client?.name ?? null, locationName: updated.locationRel?.name ?? null, startsAt: updated.startsAt, endsAt: updated.endsAt, timezone: updated.locationRel?.timezone ?? null }),
    });
  }
  return updated;
}
