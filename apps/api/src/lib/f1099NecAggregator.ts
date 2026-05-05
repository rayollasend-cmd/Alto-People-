// Gap 11 — Form 1099-NEC box aggregator.
//
// Reads PayrollItems for one contractor associate in one tax year and
// produces the per-box totals that feed Form 1099-NEC. Pure-ish: queries
// the DB but makes no writes, so it's safe to call from preview /
// regenerate flows (matches w2Aggregator's contract).
//
// Tax-year attribution follows the IRS pay-date rule (run.disbursedAt),
// matching W-2. CANCELLED runs and VOIDED items are excluded; AMENDMENT
// items contribute signed deltas exactly the way w2Aggregator handles
// them — a clawback amendment naturally reduces Box 1.
//
// Pre-tax / Section 125 / 401(k) are NOT relevant here. 1099 contractors
// are paid gross with no payroll-tax withholding (the engine sets all
// tax fields to zero for them via zeroTaxBreakdown). Box 4 is non-zero
// only when backup withholding is in effect (no W-9 on file → 24%).
//
// IRS reporting threshold: a 1099-NEC is required for a contractor if
// (Box 1 >= $600) OR (Box 4 > 0). Below threshold the IRS doesn't want
// the form filed, so listF1099NecEligibleAssociates filters those out.

import type { Prisma, PrismaClient } from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface Form1099NecBoxes {
  /** Box 1 — Nonemployee compensation (sum of grossPay for the year). */
  box1NonemployeeCompensation: number;
  /**
   * Box 2 — Payer made direct sales totaling $5,000+ to recipient.
   * Out of scope (we don't track this category of payment); always
   * false. Listed for spec completeness.
   */
  box2DirectSales: false;
  /** Box 4 — Federal income tax withheld (backup withholding). */
  box4FitWithheld: number;
  /** Box 5/6/7 — One block per state with non-zero withholding. */
  stateLines: Form1099StateLine[];
  /** Source items, count only — sanity check on the UI. */
  sourceItemCount: number;
}

export interface Form1099StateLine {
  /** Two-letter USPS code from PayrollItem.taxState (Box 6 — State/Payer's state no.). */
  state: string;
  /** Box 5 — State tax withheld. */
  stateTaxWithheld: number;
  /** Box 7 — State income (mirrors Box 1 for the state's slice). */
  stateIncome: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** IRS 1099-NEC reporting threshold (Box 1 dollars). */
export const F1099_NEC_REPORTING_THRESHOLD = 600;

/**
 * Aggregates 1099-NEC boxes for one contractor / one tax year. Returns
 * zeros if the associate had no qualifying paystubs in the year — the
 * caller decides whether to skip them (below threshold) or generate the
 * form anyway (forced regeneration / state requirement).
 */
export async function aggregateF1099NecPayments(
  tx: Tx,
  associateId: string,
  taxYear: number,
): Promise<Form1099NecBoxes> {
  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const yearEndExclusive = new Date(Date.UTC(taxYear + 1, 0, 1));

  // Same query shape as w2Aggregator.aggregateW2Wages — pay-date rule
  // via run.disbursedAt, exclude CANCELLED runs and VOIDED items, let
  // AMENDMENT signed deltas flow through naturally.
  const items = await tx.payrollItem.findMany({
    where: {
      associateId,
      status: { not: 'VOIDED' },
      payrollRun: {
        status: { not: 'CANCELLED' },
        disbursedAt: { gte: yearStart, lt: yearEndExclusive },
      },
    },
    select: {
      grossPay: true,
      federalWithholding: true,
      stateWithholding: true,
      taxState: true,
    },
  });

  let box1 = 0;
  let box4 = 0;
  const stateBuckets = new Map<string, { tax: number; income: number }>();

  for (const item of items) {
    const gross = Number(item.grossPay);
    box1 += gross;
    box4 += Number(item.federalWithholding);

    if (item.taxState) {
      const b = stateBuckets.get(item.taxState) ?? { tax: 0, income: 0 };
      b.tax += Number(item.stateWithholding);
      b.income += gross;
      stateBuckets.set(item.taxState, b);
    }
  }

  const stateLines: Form1099StateLine[] = [...stateBuckets.entries()]
    .map(([state, b]) => ({
      state,
      stateTaxWithheld: round2(b.tax),
      stateIncome: round2(b.income),
    }))
    .filter((l) => l.stateTaxWithheld !== 0 || l.stateIncome !== 0)
    .sort((a, b) => a.state.localeCompare(b.state));

  return {
    box1NonemployeeCompensation: round2(box1),
    box2DirectSales: false,
    box4FitWithheld: round2(box4),
    stateLines,
    sourceItemCount: items.length,
  };
}

/**
 * Returns contractor associate IDs that meet the 1099-NEC reporting
 * threshold for the year, scoped to one client (or all if clientId is
 * null). The threshold is (Box 1 >= $600) OR (Box 4 > 0); below that
 * the IRS doesn't want the form filed.
 *
 * Implementation: query the universe of CONTRACTOR_1099_* associates
 * with at least one disbursed item in the year, then aggregate per
 * associate and filter. Could be a single SQL groupBy + having clause
 * for very large clients; the per-associate path stays clearer and
 * the contractor population is small in practice.
 */
export async function listF1099NecEligibleAssociates(
  tx: Tx,
  taxYear: number,
  clientId: string | null,
): Promise<string[]> {
  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const yearEndExclusive = new Date(Date.UTC(taxYear + 1, 0, 1));

  const candidates = await tx.payrollItem.findMany({
    where: {
      status: { not: 'VOIDED' },
      associate: {
        employmentType: { in: ['CONTRACTOR_1099_INDIVIDUAL', 'CONTRACTOR_1099_BUSINESS'] },
      },
      payrollRun: {
        status: { not: 'CANCELLED' },
        disbursedAt: { gte: yearStart, lt: yearEndExclusive },
        ...(clientId ? { clientId } : {}),
      },
    },
    select: { associateId: true },
    distinct: ['associateId'],
  });

  const eligible: string[] = [];
  for (const c of candidates) {
    const boxes = await aggregateF1099NecPayments(tx, c.associateId, taxYear);
    if (
      boxes.box1NonemployeeCompensation >= F1099_NEC_REPORTING_THRESHOLD ||
      boxes.box4FitWithheld > 0
    ) {
      eligible.push(c.associateId);
    }
  }
  return eligible;
}
