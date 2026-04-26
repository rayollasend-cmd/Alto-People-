import type { PrismaClient } from '@prisma/client';
import { getLaborPolicy } from './stateLaborPolicy.js';
import { netWorkedMinutes } from './timeAnomalies.js';

/**
 * Phase 26 — sick-leave accrual.
 *
 * State law dictates the rate (CA: 1hr per 30hrs worked, NY: 1hr per 30,
 * WA: 1hr per 40, IL: 1hr per 40, NJ/MA/AZ/CO/OR: 1hr per 30) — see
 * StateLaborPolicy.paidSickLeaveAccrualPerHour for the full table. We hook
 * into the time-entry approval handler (when HR approves a worked entry,
 * accrual posts to the associate's ledger and balance).
 *
 * Idempotency: backed by a unique `(sourceTimeEntryId, category, reason)`
 * constraint on TimeOffLedgerEntry. Re-approving a TimeEntry never
 * double-credits — `accrueSickLeaveForEntry` swallows the unique-violation.
 *
 * Out of scope here: the *use* path (associate requests sick time) — that
 * lands in the next phase along with the request workflow.
 */

const HOUR_MIN = 60;

export interface AccrualResult {
  /** Was a fresh ledger entry written? false = idempotent no-op. */
  accrued: boolean;
  /** Minutes actually credited (0 = state has no accrual or no work). */
  earnedMinutes: number;
  /** Worked minutes the entry contributed. */
  workedMinutes: number;
  /** Two-letter state used (or null). */
  state: string | null;
  /** Per-hour rate applied (e.g. 1/30 = 0.0333…). */
  ratePerHour: number;
}

/**
 * Run sick-leave accrual for a single APPROVED TimeEntry. Safe to call
 * multiple times — the unique constraint on (sourceTimeEntryId, category,
 * reason) makes the second call a no-op. Always opens its own transaction
 * (ledger insert + balance upsert), so callers should NOT pass a
 * Prisma.TransactionClient — pass the top-level PrismaClient.
 */
export async function accrueSickLeaveForEntry(
  client: PrismaClient,
  timeEntryId: string
): Promise<AccrualResult> {
  const entry = await client.timeEntry.findUnique({
    where: { id: timeEntryId },
    include: {
      breaks: true,
      associate: { select: { state: true } },
    },
  });
  if (!entry) {
    throw new Error(`accrueSickLeaveForEntry: TimeEntry ${timeEntryId} not found`);
  }
  if (!entry.clockOutAt) {
    // Active / not yet clocked out — nothing to accrue.
    return zeroResult(entry.associate?.state ?? null, 0);
  }

  const policy = getLaborPolicy(entry.associate?.state ?? null);
  const ratePerHour = policy.paidSickLeaveAccrualPerHour;
  const workedMinutes = netWorkedMinutes(
    { clockInAt: entry.clockInAt, clockOutAt: entry.clockOutAt },
    entry.breaks
  );

  // States with rate 0 (TX, FL, GA, NC, VA, PA, federal default) accrue
  // nothing. Skip the write — no row, no idempotency key needed, and the
  // ledger doesn't carry meaningless +0 noise.
  if (ratePerHour <= 0 || workedMinutes <= 0) {
    return {
      accrued: false,
      earnedMinutes: 0,
      workedMinutes,
      state: policy.state === 'FEDERAL' ? null : policy.state,
      ratePerHour,
    };
  }

  // Credit by the minute (worked min × rate / 60). Floor so we never
  // over-credit a fraction; small leftover compounds correctly across
  // entries because the ledger is the source of truth.
  const earnedMinutes = Math.floor((workedMinutes * ratePerHour * HOUR_MIN) / HOUR_MIN);

  try {
    await client.$transaction(async (tx) => {
      await tx.timeOffLedgerEntry.create({
        data: {
          associateId: entry.associateId,
          category: 'SICK',
          reason: 'ACCRUAL',
          deltaMinutes: earnedMinutes,
          sourceTimeEntryId: entry.id,
          notes: `Accrual: ${workedMinutes} worked min × ${ratePerHour.toFixed(4)} per hr`,
        },
      });
      await tx.timeOffBalance.upsert({
        where: {
          associateId_category: {
            associateId: entry.associateId,
            category: 'SICK',
          },
        },
        create: {
          associateId: entry.associateId,
          category: 'SICK',
          balanceMinutes: earnedMinutes,
        },
        update: {
          balanceMinutes: { increment: earnedMinutes },
        },
      });
    });
    return {
      accrued: true,
      earnedMinutes,
      workedMinutes,
      state: policy.state === 'FEDERAL' ? null : policy.state,
      ratePerHour,
    };
  } catch (err) {
    // Unique-violation on (sourceTimeEntryId, category, reason) means a
    // prior approve already accrued — return idempotent no-op.
    if (isUniqueViolation(err)) {
      return {
        accrued: false,
        earnedMinutes: 0,
        workedMinutes,
        state: policy.state === 'FEDERAL' ? null : policy.state,
        ratePerHour,
      };
    }
    throw err;
  }
}

function zeroResult(state: string | null, ratePerHour: number): AccrualResult {
  return { accrued: false, earnedMinutes: 0, workedMinutes: 0, state, ratePerHour };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === 'P2002';
}
