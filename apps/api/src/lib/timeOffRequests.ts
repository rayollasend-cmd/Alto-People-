import type { Prisma, PrismaClient, TimeOffCategory } from '@prisma/client';

/**
 * Phase 30 — request/approval workflow helpers for time-off.
 *
 * Approval is the only path that mutates the balance ledger; denial and
 * cancellation never touch it. The atomicity guarantee comes from the
 * `$transaction` here plus the unique constraint on
 * `TimeOffLedgerEntry.sourceRequestId` — even a duplicate approval can
 * never write a second USE row for the same request.
 */

const HOUR_MIN = 60;

export function hoursToMinutes(hours: number): number {
  // Round to nearest minute so 0.5h granularity stays exact.
  return Math.round(hours * HOUR_MIN);
}

export function minutesToHours(minutes: number): number {
  return Math.round((minutes / HOUR_MIN) * 100) / 100;
}

/**
 * Parse a YYYY-MM-DD string as UTC midnight. We never want to interpret
 * a request's dates in the server's local timezone — that would make a
 * date submitted as "2026-04-26" land on a different calendar day for
 * an associate in Hawaii vs. one in NYC.
 */
export function parseDateUTC(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid date: ${s}`);
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}

export function formatDateUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

export interface ApproveResult {
  status: 'APPROVED';
  ledgerEntryId: string;
  newBalanceMinutes: number;
}

export class InsufficientBalanceError extends Error {
  readonly code = 'insufficient_balance';
  readonly currentMinutes: number;
  readonly requestedMinutes: number;
  constructor(currentMinutes: number, requestedMinutes: number) {
    super(`Insufficient ${requestedMinutes}min vs available ${currentMinutes}min`);
    this.currentMinutes = currentMinutes;
    this.requestedMinutes = requestedMinutes;
  }
}

export class IllegalStateError extends Error {
  readonly code = 'illegal_state';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Approve a PENDING request: flip status, write a USE ledger entry,
 * decrement the balance. All-or-nothing inside a single transaction.
 *
 * Idempotency: the unique index on (sourceRequestId) means a re-run
 * after the first commit fails the ledger insert — we surface that as
 * IllegalStateError so the caller can return 409 instead of 500.
 */
export async function approveRequest(
  client: PrismaClient,
  requestId: string,
  reviewerUserId: string,
  note: string | null
): Promise<ApproveResult> {
  // Bump the interactive-transaction timeout above Prisma's 5s default.
  // The four sequential round-trips here (find request → find balance →
  // create ledger → update balance + request) can exceed 5s on Neon
  // cold-start; tests routinely paid the full warm-up cost. 30s leaves
  // plenty of headroom while still bounding pathological cases.
  return client.$transaction(async (tx) => {
    const req = await tx.timeOffRequest.findUnique({
      where: { id: requestId },
      include: { ledgerEntry: { select: { id: true } } },
    });
    if (!req) throw new IllegalStateError('Request not found');
    if (req.status !== 'PENDING') {
      throw new IllegalStateError(`Cannot approve a ${req.status} request`);
    }
    if (req.ledgerEntry) {
      throw new IllegalStateError('Request already has a ledger entry');
    }

    const balance = await tx.timeOffBalance.findUnique({
      where: {
        associateId_category: {
          associateId: req.associateId,
          category: req.category,
        },
      },
    });
    const currentMinutes = balance?.balanceMinutes ?? 0;
    if (currentMinutes < req.requestedMinutes) {
      throw new InsufficientBalanceError(currentMinutes, req.requestedMinutes);
    }

    const ledgerEntry = await tx.timeOffLedgerEntry.create({
      data: {
        associateId: req.associateId,
        category: req.category,
        reason: 'USE',
        deltaMinutes: -req.requestedMinutes,
        sourceRequestId: req.id,
        sourceUserId: reviewerUserId,
        notes: note ?? null,
      },
    });

    const updatedBalance = await tx.timeOffBalance.update({
      where: {
        associateId_category: {
          associateId: req.associateId,
          category: req.category,
        },
      },
      data: { balanceMinutes: { decrement: req.requestedMinutes } },
    });

    await tx.timeOffRequest.update({
      where: { id: req.id },
      data: {
        status: 'APPROVED',
        reviewerUserId,
        reviewerNote: note,
        decidedAt: new Date(),
      },
    });

    return {
      status: 'APPROVED' as const,
      ledgerEntryId: ledgerEntry.id,
      newBalanceMinutes: updatedBalance.balanceMinutes,
    };
  }, { timeout: 30_000 });
}

/**
 * Test-only helper used by integration tests to seed a non-zero balance.
 * Production code creates balances exclusively through ACCRUAL or
 * approved-USE rows; this exists so a request-flow test doesn't need
 * to also set up a worked-and-approved TimeEntry.
 */
export async function adjustBalance(
  client: Prisma.TransactionClient | PrismaClient,
  associateId: string,
  category: TimeOffCategory,
  deltaMinutes: number,
  notes: string
) {
  await client.timeOffLedgerEntry.create({
    data: {
      associateId,
      category,
      reason: 'ADJUSTMENT',
      deltaMinutes,
      notes,
    },
  });
  await client.timeOffBalance.upsert({
    where: { associateId_category: { associateId, category } },
    create: { associateId, category, balanceMinutes: deltaMinutes },
    update: { balanceMinutes: { increment: deltaMinutes } },
  });
}
