import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { enqueueAudit } from './audit.js';
import { endEmployment } from './employment.js';
import { releaseFutureShifts } from './deactivation.js';
import { repairSoon } from './scheduleRepair.js';
import { purgeAssociateBiometrics } from './kioskMaintenance.js';
import { maybeNotifyFinanceDeparture } from './fieldglassNotify.js';
import { notifyAllAdmins, trackNotificationWork } from './notify.js';
import { emitWebhookEvent } from './webhookDispatch.js';
import { closeOpenAssignments } from './assignmentDates.js';
import { emitWorkerStatusChanged } from './webhookEvents.js';
import { emit as emitWorkflow } from './workflow.js';

/**
 * Completing a separation is the termination event. It is one function so
 * the route (one person, where no second is available) and the approval
 * engine (the second person's decision) do exactly the same thing:
 * deactivate the person, end the employment spell, close assignments,
 * release future shifts, disable logins, purge biometrics, ring Finance,
 * fire the webhooks and the ASSOCIATE_TERMINATED workflows.
 */
/** Nothing completes while company property is still out, unless HR waived it with a reason. */
export async function assertAssetsReturned(associateId: string, waivedAt: Date | null): Promise<void> {
  if (waivedAt) return;
  const outstanding = await prisma.assetAssignment.count({ where: { associateId, returnedAt: null } });
  if (outstanding > 0) {
    throw new HttpError(409, 'assets_outstanding', `${outstanding} ${outstanding === 1 ? 'asset is' : 'assets are'} still assigned to this person. Record their return, or waive with a reason.`);
  }
}

export async function completeSeparation(id: string, actorUserId: string, opts: { approvalRequestId?: string | null; note?: string | null } = {}): Promise<void> {
  const existing = await prisma.separation.findUnique({
    where: { id },
    include: { associate: { select: { firstName: true, lastName: true } } },
  });
  if (!existing) throw new HttpError(404, 'not_found', 'Separation not found.');
  if (existing.status === 'COMPLETE') throw new HttpError(409, 'already_complete', 'Already complete.');
  await assertAssetsReturned(existing.associateId, existing.assetsWaivedAt);

  const disabledUserIds: string[] = [];
  let releasedShiftIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.separation.update({
      where: { id },
      data: { status: 'COMPLETE', completedAt: new Date(), completedById: actorUserId },
    });
    await tx.associate.update({ where: { id: existing.associateId }, data: { separatedAt: new Date() } });
    await endEmployment(tx, existing.associateId, existing.lastDayWorked ?? new Date());
    await closeOpenAssignments(tx, { associateId: existing.associateId, endedAt: existing.lastDayWorked, endLabel: 'last day worked' });
    ({ releasedShiftIds } = await releaseFutureShifts(tx, existing.associateId, new Date(), 'Associate separated.'));
    const users = await tx.user.findMany({
      where: { associateId: existing.associateId, deletedAt: null, status: { not: 'DISABLED' } },
      select: { id: true },
    });
    if (users.length > 0) {
      await tx.user.updateMany({ where: { id: { in: users.map((u) => u.id) } }, data: { status: 'DISABLED', tokenVersion: { increment: 1 } } });
      disabledUserIds.push(...users.map((u) => u.id));
    }
  });
  for (const uid of disabledUserIds) invalidateUserCache(uid);
  enqueueAudit(
    { actorUserId, action: 'separation.completed', entityType: 'Separation', entityId: id, metadata: { associateId: existing.associateId, approvalRequestId: opts.approvalRequestId ?? null, note: opts.note ?? null } },
    'separationComplete',
  );
  repairSoon(releasedShiftIds, { kind: 'separation', associateId: existing.associateId });
  try {
    await purgeAssociateBiometrics(prisma, existing.associateId);
  } catch (err) {
    console.warn('[separation] purgeAssociateBiometrics failed', { separationId: id, associateId: existing.associateId, err: err instanceof Error ? err.message : err });
  }
  void trackNotificationWork(maybeNotifyFinanceDeparture(existing.associateId, existing.lastDayWorked));
  emitWorkerStatusChanged({ associateId: existing.associateId }, 'separated');
  const lastDay = existing.lastDayWorked.toISOString().slice(0, 10);
  void emitWebhookEvent('associate.terminated', {
    associateId: existing.associateId,
    separationId: existing.id,
    reason: existing.reason,
    lastDayWorked: lastDay,
  });
  await emitWorkflow({
    trigger: 'ASSOCIATE_TERMINATED',
    entityType: 'Separation',
    entityId: existing.id,
    context: { associateId: existing.associateId, separation: { id: existing.id, reason: existing.reason, lastDayWorked: lastDay }, approvalRequestId: opts.approvalRequestId ?? null },
  });
  const who = `${existing.associate.firstName} ${existing.associate.lastName}`;
  void notifyAllAdmins({
    subject: `Separation completed: ${who}`,
    body: `Separation completed for ${who} — access revoked, biometrics purged.`,
    category: 'separation',
    linkUrl: '/separations',
    excludeUserId: actorUserId,
  });
}
