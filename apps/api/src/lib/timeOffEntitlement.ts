import type { Prisma, TimeOffCategory } from '@prisma/client';

/**
 * Phase 43 — annual entitlement reset & lump-sum grant.
 *
 * One associate × category gets one entitlement row. The reset date is
 * the same MM-DD of `policyAnchorDate` every year (default Jan 1). On
 * the first call after a reset boundary, this helper:
 *   1. Caps any existing balance at carryoverMaxMinutes (writing a
 *      negative CARRYOVER_FORFEIT ledger entry for the excess).
 *   2. Adds annualMinutes to the balance (writing a positive
 *      ANNUAL_GRANT ledger entry).
 *   3. Stamps lastGrantedAt = today so subsequent calls in the same
 *      window are no-ops.
 *
 * Idempotent: the lastGrantedAt check guards against double-grants.
 * Safe to call from the request-create path, the approve path, and the
 * me/balance read — whichever fires first wins, the rest skip.
 */
export async function ensureEntitlementApplied(
  tx: Prisma.TransactionClient,
  associateId: string,
  category: TimeOffCategory,
  now: Date = new Date()
): Promise<void> {
  const ent = await tx.timeOffEntitlement.findUnique({
    where: { associateId_category: { associateId, category } },
  });
  if (!ent) return; // No entitlement configured → no automatic grants.

  const dueDate = nextResetOnOrBefore(ent.policyAnchorDate, now);
  if (ent.lastGrantedAt && ent.lastGrantedAt >= dueDate) {
    // Already granted for this window.
    return;
  }

  const balance = await tx.timeOffBalance.findUnique({
    where: { associateId_category: { associateId, category } },
  });
  const currentMinutes = balance?.balanceMinutes ?? 0;

  // 1. Forfeit any excess above the carryover cap.
  if (currentMinutes > ent.carryoverMaxMinutes) {
    const forfeit = ent.carryoverMaxMinutes - currentMinutes; // negative
    await tx.timeOffLedgerEntry.create({
      data: {
        associateId,
        category,
        reason: 'CARRYOVER_FORFEIT',
        deltaMinutes: forfeit,
        notes: `Year-end carryover cap = ${ent.carryoverMaxMinutes} minutes`,
      },
    });
  }
  const minutesAfterForfeit = Math.min(currentMinutes, ent.carryoverMaxMinutes);

  // 2. Grant annualMinutes on top.
  await tx.timeOffLedgerEntry.create({
    data: {
      associateId,
      category,
      reason: 'ANNUAL_GRANT',
      deltaMinutes: ent.annualMinutes,
      notes: `Annual ${category} grant of ${ent.annualMinutes} minutes`,
    },
  });

  // 3. Land on the new balance.
  const newBalance = minutesAfterForfeit + ent.annualMinutes;
  await tx.timeOffBalance.upsert({
    where: { associateId_category: { associateId, category } },
    create: { associateId, category, balanceMinutes: newBalance },
    update: { balanceMinutes: newBalance },
  });

  await tx.timeOffEntitlement.update({
    where: { id: ent.id },
    data: { lastGrantedAt: dueDate },
  });
}

/**
 * Most-recent reset boundary on or before `now`, derived from the
 * anchor's MM-DD applied to the current year. If today is before the
 * anchor for this year, the last reset was the prior year's anchor.
 */
export function nextResetOnOrBefore(anchor: Date, now: Date): Date {
  const month = anchor.getUTCMonth();
  const day = anchor.getUTCDate();
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), month, day));
  if (candidate <= now) return candidate;
  return new Date(Date.UTC(now.getUTCFullYear() - 1, month, day));
}
