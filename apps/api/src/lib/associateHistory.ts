import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Phase 77 — Effective-dated AssociateHistory helpers.
 *
 * Two write paths:
 *  - recordChange(): "the associate's manager / department / etc. just
 *    changed; close the current row and open a new one starting now."
 *    Idempotent if the new values match the current row (no-ops).
 *  - backfillCurrent(): "ensure a current row exists at this exact
 *    snapshot." Used by migrations or imports when there's no prior
 *    history. Inserts only if no current row exists.
 *
 * One read path:
 *  - asOf(): "what were the tracked fields for this associate on
 *    `when`?" Returns the row whose [effectiveFrom, effectiveTo) window
 *    contains `when`, or null if `when` predates any history.
 */

export interface AssociateHistorySnapshot {
  managerId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  jobProfileId: string | null;
  state: string | null;
  hourlyRate: Prisma.Decimal | null;
}

export interface RecordChangeArgs extends AssociateHistorySnapshot {
  associateId: string;
  reason?: string | null;
  actorUserId?: string | null;
  effectiveFrom?: Date;
}

function snapshotsEqual(
  a: AssociateHistorySnapshot,
  b: AssociateHistorySnapshot,
): boolean {
  return (
    a.managerId === b.managerId &&
    a.departmentId === b.departmentId &&
    a.costCenterId === b.costCenterId &&
    a.jobProfileId === b.jobProfileId &&
    a.state === b.state &&
    decimalEqual(a.hourlyRate, b.hourlyRate)
  );
}

function decimalEqual(
  a: Prisma.Decimal | null,
  b: Prisma.Decimal | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.equals(b);
}

/**
 * Record a change to the tracked fields. Closes the current row's
 * effectiveTo and inserts a new current row, in a single transaction.
 * No-op when the new snapshot matches the current row (so callers don't
 * have to filter equal-noop updates).
 */
export async function recordChange(
  prisma: PrismaClient,
  args: RecordChangeArgs,
): Promise<void> {
  const effectiveFrom = args.effectiveFrom ?? new Date();
  const newSnapshot: AssociateHistorySnapshot = {
    managerId: args.managerId,
    departmentId: args.departmentId,
    costCenterId: args.costCenterId,
    jobProfileId: args.jobProfileId,
    state: args.state,
    hourlyRate: args.hourlyRate,
  };

  await prisma.$transaction(async (tx) => {
    const current = await tx.associateHistory.findFirst({
      where: { associateId: args.associateId, effectiveTo: null },
    });

    if (current && snapshotsEqual(current, newSnapshot)) {
      return; // idempotent no-op
    }

    if (current) {
      await tx.associateHistory.update({
        where: { id: current.id },
        data: { effectiveTo: effectiveFrom },
      });
    }

    await tx.associateHistory.create({
      data: {
        associateId: args.associateId,
        effectiveFrom,
        managerId: newSnapshot.managerId,
        departmentId: newSnapshot.departmentId,
        costCenterId: newSnapshot.costCenterId,
        jobProfileId: newSnapshot.jobProfileId,
        state: newSnapshot.state,
        hourlyRate: newSnapshot.hourlyRate,
        reason: args.reason ?? null,
        actorUserId: args.actorUserId ?? null,
      },
    });
  });
}

/**
 * Insert a current row if none exists. Used by importers / migrations to
 * seed the history table without disturbing any existing rows.
 */
export async function backfillCurrent(
  prisma: PrismaClient,
  associateId: string,
  snapshot: AssociateHistorySnapshot,
  effectiveFrom: Date,
): Promise<void> {
  const existing = await prisma.associateHistory.findFirst({
    where: { associateId, effectiveTo: null },
  });
  if (existing) return;
  await prisma.associateHistory.create({
    data: {
      associateId,
      effectiveFrom,
      ...snapshot,
      reason: 'backfill',
    },
  });
}

/**
 * Resolve the as-of snapshot for an associate at the given timestamp.
 * Returns null when there's no row whose window contains `when` (i.e.
 * `when` predates the earliest history entry).
 */
export async function asOf(
  prisma: PrismaClient,
  associateId: string,
  when: Date,
): Promise<AssociateHistorySnapshot | null> {
  const row = await prisma.associateHistory.findFirst({
    where: {
      associateId,
      effectiveFrom: { lte: when },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: when } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row) return null;
  return {
    managerId: row.managerId,
    departmentId: row.departmentId,
    costCenterId: row.costCenterId,
    jobProfileId: row.jobProfileId,
    state: row.state,
    hourlyRate: row.hourlyRate,
  };
}
