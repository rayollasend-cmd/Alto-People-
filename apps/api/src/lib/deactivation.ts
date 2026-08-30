import type { PrismaClient } from '@prisma/client';
import { invalidateUserCache } from '../middleware/auth.js';

/**
 * The one deactivation transaction — shared by the manual "Deactivate"
 * button (routes/org.ts) and the dormancy auto-sweep (lib/dormancySweep.ts)
 * so the two paths can never drift apart. One transaction takes the
 * associate fully out of circulation:
 *
 *   - deactivatedAt / reason stamped (byUserId null = system sweep),
 *   - future ASSIGNED shifts released back to OPEN (the no-show engine
 *     must not accrue points against someone who isn't supposed to be
 *     there, and supervisors can re-cover the slots),
 *   - pending open-shift claims expired,
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
    const released = await tx.shift.updateMany({
      where: {
        assignedAssociateId: opts.associateId,
        status: 'ASSIGNED',
        startsAt: { gt: now },
      },
      data: { status: 'OPEN', assignedAssociateId: null },
    });
    releasedShifts = released.count;
    const expired = await tx.openShiftClaim.updateMany({
      where: { associateId: opts.associateId, status: 'PENDING' },
      data: { status: 'EXPIRED', decisionNote: 'Associate deactivated.' },
    });
    expiredClaims = expired.count;
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
