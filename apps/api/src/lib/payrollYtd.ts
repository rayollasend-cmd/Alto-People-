// Gap 8 close — Live YTD wage aggregation.
//
// The payroll engine needs an associate's prior-year-to-date wages at
// run-creation time so it can apply the Social Security wage cap (item
// drops to 0% FICA once YTD crosses the cap), the Medicare 0.9% surcharge
// (kicks in over $200k YTD), and any state-specific wage-base ceilings.
//
// The previous implementation summed `grossPay` across ALL prior items
// for the associate in the same calendar year. That worked while there
// was nothing in the system that could *invalidate* a prior item — but
// once Gap 3 ships voids and amendments, the snapshot pattern silently
// drifts:
//
//   - A voided run still contributed grossPay to a later run's YTD.
//   - An amendment that corrected wages downward never reduced the YTD.
//
// This helper replaces the inline aggregate with a single source of
// truth that filters out CANCELLED runs and non-DISBURSED items, and
// trusts AMENDMENT items to carry signed deltas (positive supplemental
// pay, negative clawback) that sum naturally to the corrected YTD.

import type { Prisma, PrismaClient } from '@prisma/client';

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Sum DISBURSED grossPay for an associate across non-cancelled runs whose
 * `periodStart` lies in `[yearStart, beforeDate)`. Returns dollars as a
 * Number (the tax engine works in plain numbers, not Prisma.Decimal).
 *
 * - Excluded: items on runs with `status = CANCELLED` (voided runs).
 * - Excluded: items with `status` other than DISBURSED (PENDING/HELD/
 *   FAILED items represent "supposed to be paid but wasn't" — including
 *   them would inflate YTD against money the associate never received).
 * - Included: AMENDMENT items, regardless of sign. A negative-grossPay
 *   amendment (clawback) reduces the sum exactly as required.
 */
export async function computeYtdWages(
  tx: Tx,
  associateId: string,
  yearStart: Date,
  beforeDate: Date
): Promise<number> {
  const result = await tx.payrollItem.aggregate({
    where: {
      associateId,
      status: 'DISBURSED',
      payrollRun: {
        periodStart: { gte: yearStart, lt: beforeDate },
        status: { not: 'CANCELLED' },
      },
    },
    _sum: { grossPay: true },
  });
  return Number(result._sum.grossPay ?? 0);
}

/**
 * Companion helper for Medicare wages. The Medicare base differs from the
 * FIT base: pre-tax 401(k) reduces FIT wages but not Medicare wages, so
 * Medicare YTD can run higher than FIT YTD. The current aggregator stores
 * `ytdMedicareWages = ytdWages` as a known approximation; this helper
 * exists so the divergence can be tightened in a later pass without
 * threading a second aggregate through every call site.
 *
 * For now, identical math to computeYtdWages — kept as a separate symbol
 * so the call sites that conceptually want "Medicare base YTD" name what
 * they want.
 */
export async function computeYtdMedicareWages(
  tx: Tx,
  associateId: string,
  yearStart: Date,
  beforeDate: Date
): Promise<number> {
  return computeYtdWages(tx, associateId, yearStart, beforeDate);
}

// Gap 3 — Pending overpayment-clawback deduction consumer.
//
// Run-creation calls this for each new REGULAR-run PayrollItem to drain
// open PendingPayrollDeduction rows for the associate. The drain is
// capped at the item's available net pay so we never push the associate
// to negative take-home. Rows that fully fit get consumed (appliedRunId
// stamped); a row that doesn't fit completely has its remaining amount
// reduced in place and stays open for the next run to absorb.
//
// Returns the total applied amount so the caller can reflect it in
// postTaxDeductions / netPay. Callers in preview / read-only paths
// MUST NOT call this — it mutates DB state.
export interface DeductionConsumeResult {
  /** Total dollars consumed across all pending rows for this associate. */
  totalApplied: number;
  /** Number of pending rows touched (consumed or partially reduced). */
  rowsTouched: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function consumePendingDeductions(
  tx: Tx,
  args: {
    associateId: string;
    availableNet: number;
    payrollRunId: string;
    payrollItemId: string;
  }
): Promise<DeductionConsumeResult> {
  if (args.availableNet <= 0) return { totalApplied: 0, rowsTouched: 0 };

  const pending = await tx.pendingPayrollDeduction.findMany({
    where: { associateId: args.associateId, appliedRunId: null },
    orderBy: { createdAt: 'asc' },
  });
  if (pending.length === 0) return { totalApplied: 0, rowsTouched: 0 };

  let remaining = args.availableNet;
  let totalApplied = 0;
  let rowsTouched = 0;
  const now = new Date();

  for (const row of pending) {
    if (remaining <= 0) break;
    const rowAmount = Number(row.amount);
    const applied = Math.min(rowAmount, remaining);
    totalApplied += applied;
    remaining -= applied;
    rowsTouched += 1;

    if (applied >= rowAmount) {
      // Full apply — stamp run + item + appliedAt so the row drops out
      // of the open-deductions partial index.
      await tx.pendingPayrollDeduction.update({
        where: { id: row.id },
        data: {
          appliedRunId: args.payrollRunId,
          appliedItemId: args.payrollItemId,
          appliedAt: now,
        },
      });
    } else {
      // Partial apply — reduce remaining magnitude, keep row open. We
      // intentionally don't track which run absorbed which slice; the
      // run's own item.postTaxDeductions captures the absorbed amount,
      // and the chain back to the source amendment is preserved on the
      // unchanged sourceAmendmentItemId.
      await tx.pendingPayrollDeduction.update({
        where: { id: row.id },
        data: { amount: round2(rowAmount - applied) },
      });
    }
  }

  return { totalApplied: round2(totalApplied), rowsTouched };
}
