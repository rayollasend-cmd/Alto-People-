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
import { findInChunks } from './chunkedIn.js';
import { companyWorkweek, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { dateColumnKey } from './timezone.js';

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Sum DISBURSED grossPay for an associate across non-cancelled runs whose
 * `periodStart` lies in `[yearStart, beforeDate)`. Returns dollars as a
 * Number (the tax engine works in plain numbers, not Prisma.Decimal).
 *
 * Windowed on the run's periodStart. PAY RUNS DON'T USE THIS: the
 * aggregator counts on the pay-date basis (computeYtdWagesPaidBatch below,
 * deep audit CODE-2), as the W-2 does. The day-by-day callers (daily pay,
 * manual checks, the take-home estimate) keep this window: a daily check
 * for yesterday is often paid after today began, and would drop out of a
 * disbursedAt window bounded by today.
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
 * Batched variant — one groupBy for a whole run's universe instead of one
 * aggregate per associate (the aggregator used to issue 2N of these, N of
 * them exact duplicates via computeYtdMedicareWages). Missing associates
 * simply have no key → treat as 0.
 */
export async function computeYtdWagesBatch(
  tx: Tx,
  associateIds: string[],
  yearStart: Date,
  beforeDate: Date
): Promise<Map<string, number>> {
  if (associateIds.length === 0) return new Map();
  const groups = await findInChunks(associateIds, (chunk) =>
    tx.payrollItem.groupBy({
      by: ['associateId'],
      where: {
        associateId: { in: chunk },
        status: 'DISBURSED',
        payrollRun: {
          periodStart: { gte: yearStart, lt: beforeDate },
          status: { not: 'CANCELLED' },
        },
      },
      _sum: { grossPay: true },
    }),
  );
  const ytd = new Map(groups.map((g) => [g.associateId, Number(g._sum.grossPay ?? 0)]));
  // Third-party sick pay's taxable part counts toward the year's Social
  // Security wage base too (it's FICA wages on the W-2), so a high earner
  // isn't withheld past the limit. Skipped where the table isn't there (the
  // labor golden's fake transaction).
  const sick = (tx as unknown as { thirdPartySickPay?: { findMany: (a: unknown) => Promise<Array<{ associateId: string; grossAmount: unknown; nontaxableAmount: unknown }>> } }).thirdPartySickPay;
  if (sick?.findMany) {
    const rows = await findInChunks(associateIds, (chunk) =>
      sick.findMany({
        where: { associateId: { in: chunk }, voidedAt: null, payDate: { gte: yearStart, lt: beforeDate } },
        select: { associateId: true, grossAmount: true, nontaxableAmount: true },
      }),
    );
    for (const r of rows) {
      const taxable = Math.max(0, Number(r.grossAmount) - Number(r.nontaxableAmount));
      if (taxable > 0) ytd.set(r.associateId, (ytd.get(r.associateId) ?? 0) + taxable);
    }
  }
  return ytd;
}

/**
 * The tax year of a check and the window its prior checks are counted in
 * (deep audit CODE-2): the PAY DATE's calendar year — the W-2's, the 941's
 * and the tax ledger's basis — from Jan 1 through the end of the pay day.
 * The check for Sat Dec 19, 2026 – Fri Jan 1, 2027, paid Fri Jan 8, 2027,
 * is a 2027 check: it starts 2027's wage bases and limits.
 */
export interface TaxYearWindow {
  taxYear: number;
  /** Jan 1 and the day after the pay day, as calendar days (UTC midnight) — for DATE columns (periods, sick-pay dates). */
  yearStart: Date;
  before: Date;
  /**
   * The same two days as instants, midnight on the COMPANY's calendar — for
   * a paid-at timestamp. A check paid at 9 PM Eastern on the pay day was paid
   * that day (UTC already calls it tomorrow: a second run that evening left
   * it out of the year-to-date), and one paid the evening of Dec 31 is that
   * year's.
   */
  paidFrom: Date;
  paidBefore: Date;
}

export function taxYearWindow(payDate: Date): TaxYearWindow {
  const taxYear = payDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const endOfPayDay = Date.UTC(taxYear, payDate.getUTCMonth(), payDate.getUTCDate()) + 86_400_000;
  const before = new Date(Math.min(endOfPayDay, Date.UTC(taxYear + 1, 0, 1)));
  const tz = companyWorkweek().timezone;
  return {
    taxYear,
    yearStart,
    before,
    paidFrom: utcInstantOfLocalMidnight(dateColumnKey(yearStart), tz),
    paidBefore: utcInstantOfLocalMidnight(dateColumnKey(before), tz),
  };
}

/**
 * Prior checks in a check's tax year, for the year's limits (state-program
 * wage caps, supplemental tiers, deferral limits): checks PAID in the window
 * (taxYearWindow), plus checks approved and not yet paid whose period began
 * in the year (a run in flight still uses up the limits). Never the run's
 * own checks, voided checks or cancelled runs.
 */
export function priorChecksInTaxYear(input: Omit<TaxYearWindow, 'taxYear'> & { periodStart: Date; runId?: string | null }): Prisma.PayrollItemWhereInput {
  const paid = { gte: input.paidFrom, lt: input.paidBefore };
  return {
    ...(input.runId ? { payrollRunId: { not: input.runId } } : {}),
    OR: [
      { status: 'DISBURSED', disbursedAt: paid, payrollRun: { status: { not: 'CANCELLED' } } },
      { status: 'DISBURSED', disbursedAt: null, payrollRun: { status: { not: 'CANCELLED' }, disbursedAt: paid } },
      // A paid check with no paid date anywhere (imported history): its period's end stands in.
      { status: 'DISBURSED', disbursedAt: null, payrollRun: { status: { not: 'CANCELLED' }, disbursedAt: null, periodEnd: { gte: input.yearStart, lt: input.before } } },
      { status: { in: ['PENDING', 'HELD'] }, payrollRun: { status: 'FINALIZED', periodStart: { gte: input.yearStart, lt: input.periodStart } } },
    ],
  };
}

/**
 * Year-to-date wages for the wage bases (Social Security, FUTA, SUTA, the
 * Medicare surcharge) ON THE PAY-DATE BASIS (deep audit CODE-2): gross of
 * the checks actually paid in the pay date's year up to the pay day — what
 * the W-2 will report. Batched for a run's universe; missing = 0.
 */
export async function computeYtdWagesPaidBatch(
  tx: Tx,
  associateIds: string[],
  payDate: Date,
  excludeRunId?: string | null,
): Promise<Map<string, number>> {
  if (associateIds.length === 0) return new Map();
  const { yearStart, before, paidFrom, paidBefore } = taxYearWindow(payDate);
  const paid = { gte: paidFrom, lt: paidBefore };
  const groups = await findInChunks(associateIds, (chunk) =>
    tx.payrollItem.groupBy({
      by: ['associateId'],
      where: {
        associateId: { in: chunk },
        status: 'DISBURSED',
        ...(excludeRunId ? { payrollRunId: { not: excludeRunId } } : {}),
        payrollRun: { status: { not: 'CANCELLED' } },
        // The check's own paid date; a check marked paid without one takes its run's.
        OR: [
          { disbursedAt: paid },
          { disbursedAt: null, payrollRun: { disbursedAt: paid } },
          // No paid date anywhere (imported history): its period's end stands in.
          { disbursedAt: null, payrollRun: { disbursedAt: null, periodEnd: { gte: yearStart, lt: before } } },
        ],
      },
      _sum: { grossPay: true },
    }),
  );
  const ytd = new Map(groups.map((g) => [g.associateId, Number(g._sum.grossPay ?? 0)]));
  // Third-party sick pay's taxable part is FICA wages on the W-2 (see computeYtdWagesBatch).
  const sick = (tx as unknown as { thirdPartySickPay?: { findMany: (a: unknown) => Promise<Array<{ associateId: string; grossAmount: unknown; nontaxableAmount: unknown }>> } }).thirdPartySickPay;
  if (sick?.findMany) {
    const rows = await findInChunks(associateIds, (chunk) =>
      sick.findMany({
        where: { associateId: { in: chunk }, voidedAt: null, payDate: { gte: yearStart, lt: before } },
        select: { associateId: true, grossAmount: true, nontaxableAmount: true },
      }),
    );
    for (const r of rows) {
      const taxable = Math.max(0, Number(r.grossAmount) - Number(r.nontaxableAmount));
      if (taxable > 0) ytd.set(r.associateId, (ytd.get(r.associateId) ?? 0) + taxable);
    }
  }
  return ytd;
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
