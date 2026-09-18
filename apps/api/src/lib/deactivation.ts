import type { Prisma, PrismaClient } from '@prisma/client';
import { invalidateUserCache } from '../middleware/auth.js';

/**
 * The one deactivation transaction — shared by the manual "Deactivate"
 * button (routes/org.ts) and the dormancy auto-sweep (lib/dormancySweep.ts)
 * so the two paths can never drift apart. One transaction takes the
 * associate fully out of circulation:
 *
 *   - deactivatedAt / reason stamped (byUserId null = system sweep),
 *   - future shifts released (releaseFutureShifts: ASSIGNED back to OPEN
 *     so supervisors can re-cover the slots and the no-show engine never
 *     accrues points against someone who isn't supposed to be there;
 *     DRAFT assignments unassigned) and pending pickup claims expired,
 *   - login DISABLED with live sessions killed (tokenVersion bump).
 *
 * Directory INACTIVE display and the kiosk punch rejection are both
 * derived from deactivatedAt — no extra writes needed here. Reactivate
 * (routes/org.ts) undoes exactly this set.
 *
 * Caller preconditions (route/sweep both enforce before calling): the
 * associate exists, is not deleted/erased/separated, and is not already
 * deactivated. User-cache invalidation happens here so no caller can
 * forget it.
 */
/**
 * Take someone who no longer works here off every shift still ahead of
 * them — the one rule shared by deactivation, separation completion, and
 * the one-off cleanup script. Published assignments go back to OPEN so a
 * supervisor can re-cover the slot; DRAFT assignments are unassigned and
 * stay drafts (the manager's plan, minus the person). Pending pickup
 * requests expire. Past and in-progress shifts are history — untouched.
 */
export async function releaseFutureShifts(
  tx: Prisma.TransactionClient,
  associateId: string,
  now: Date,
  note: string,
): Promise<{ releasedShifts: number; expiredClaims: number }> {
  const published = await tx.shift.updateMany({
    where: { assignedAssociateId: associateId, status: 'ASSIGNED', startsAt: { gt: now } },
    data: { status: 'OPEN', assignedAssociateId: null, assignedAt: null },
  });
  const drafts = await tx.shift.updateMany({
    where: { assignedAssociateId: associateId, status: 'DRAFT', startsAt: { gt: now } },
    data: { assignedAssociateId: null, assignedAt: null },
  });
  const expired = await tx.openShiftClaim.updateMany({
    where: { associateId, status: 'PENDING' },
    data: { status: 'EXPIRED', decisionNote: note },
  });
  return { releasedShifts: published.count + drafts.count, expiredClaims: expired.count };
}

export interface DeactivationResult {
  releasedShifts: number;
  expiredClaims: number;
  disabledUserIds: string[];
}

export async function executeDeactivation(
  prisma: PrismaClient,
  opts: {
    associateId: string;
    byUserId: string | null;
    reason: string;
    now?: Date;
  },
): Promise<DeactivationResult> {
  const now = opts.now ?? new Date();
  const disabledUserIds: string[] = [];
  let releasedShifts = 0;
  let expiredClaims = 0;
  await prisma.$transaction(async (tx) => {
    await tx.associate.update({
      where: { id: opts.associateId },
      data: {
        deactivatedAt: now,
        deactivatedById: opts.byUserId,
        deactivationReason: opts.reason,
      },
    });
    // Drafts assigned to them used to survive deactivation and keep the
    // person on next week's schedule; the shared rule releases both.
    ({ releasedShifts, expiredClaims } = await releaseFutureShifts(
      tx,
      opts.associateId,
      now,
      'Associate deactivated.',
    ));
    // Same access-revocation pattern as separation completion.
    const users = await tx.user.findMany({
      where: {
        associateId: opts.associateId,
        deletedAt: null,
        status: { not: 'DISABLED' },
      },
      select: { id: true },
    });
    if (users.length > 0) {
      await tx.user.updateMany({
        where: { id: { in: users.map((u) => u.id) } },
        data: { status: 'DISABLED', tokenVersion: { increment: 1 } },
      });
      disabledUserIds.push(...users.map((u) => u.id));
    }
  });
  for (const uid of disabledUserIds) invalidateUserCache(uid);
  return { releasedShifts, expiredClaims, disabledUserIds };
}
