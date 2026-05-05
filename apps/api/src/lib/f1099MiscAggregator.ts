// Gap 11 — Phase 8: Form 1099-MISC box aggregator.
//
// Mirrors f1099NecAggregator's contract but produces 1099-MISC boxes
// instead of NEC. Same query (PayrollItem rows in the year, pay-date
// rule via run.disbursedAt, exclude CANCELLED runs and VOIDED items,
// AMENDMENT signed deltas flow through), same caller shape.
//
// Box mapping:
//   Our data model has one PayrollItem.grossPay column with no payment-
//   category tag, so we can't natively distinguish rents (Box 1) from
//   royalties (Box 2) from other income (Box 3). For the MVP we route
//   grossPay to Box 3 — "Other income" — which is the most generic
//   landing zone the IRS provides. A future Migration can add a
//   `payment_category` enum on PayrollItem to support per-vendor box
//   mapping; this aggregator returns a complete Form1099MiscBoxes shape
//   so consumers don't need to change when that lands.
//
// Reporting thresholds (per IRS instructions for Form 1099-MISC, TY 2024):
//   - Box 2 (Royalties): $10
//   - Most other boxes: $600
//   - Box 4 (FIT withheld): any amount > $0 (backup withholding always
//     triggers a return regardless of the underlying box totals)
// listF1099MiscEligibleAssociates filters by these.

import type { Prisma, PrismaClient } from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface Form1099MiscBoxes {
  /** Box 1 — Rents. */
  box1Rents: number;
  /** Box 2 — Royalties. Lower threshold than other boxes ($10). */
  box2Royalties: number;
  /** Box 3 — Other income (default landing zone for grossPay in MVP). */
  box3OtherIncome: number;
  /** Box 4 — Federal income tax withheld (backup withholding). */
  box4FitWithheld: number;
  /** Box 5 — Fishing boat proceeds. */
  box5FishingBoatProceeds: number;
  /** Box 6 — Medical and health care payments. */
  box6MedicalHealthcarePayments: number;
  /**
   * Box 7 — Payer made direct sales totaling $5,000+ to recipient
   * (checkbox, not dollars). MVP: always false; we don't track this
   * category. Listed for spec completeness.
   */
  box7DirectSales: false;
  /** Box 8 — Substitute payments in lieu of dividends/interest. */
  box8SubstitutePayments: number;
  /** Box 9 — Crop insurance proceeds. */
  box9CropInsuranceProceeds: number;
  /** Box 10 — Gross proceeds paid to an attorney. */
  box10GrossProceedsAttorney: number;
  /** Box 11 — Fish purchased for resale. */
  box11FishForResale: number;
  /** Box 12 — Section 409A deferrals. */
  box12Section409ADeferrals: number;
  /** Box 13 — Excess golden parachute payments. */
  box13ExcessGoldenParachute: number;
  /** Box 14 — Nonqualified deferred compensation. */
  box14NonqualifiedDeferred: number;
  /** Boxes 15-17 — One block per state with non-zero withholding. */
  stateLines: Form1099MiscStateLine[];
  /** Source items, count only — sanity check on the UI. */
  sourceItemCount: number;
}

export interface Form1099MiscStateLine {
  /** Two-letter USPS code from PayrollItem.taxState. */
  state: string;
  /** Box 16 — State tax withheld. */
  stateTaxWithheld: number;
  /** Box 17 — State income (mirrors the relevant box for the state slice). */
  stateIncome: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * IRS reporting thresholds per box (TY 2024). Forms below all thresholds
 * (and Box 4 == 0) shouldn't be filed.
 */
export const F1099_MISC_REPORTING_THRESHOLDS = {
  box1Rents: 600,
  box2Royalties: 10, // royalties get the lower threshold
  box3OtherIncome: 600,
  box5FishingBoatProceeds: 600,
  box6MedicalHealthcarePayments: 600,
  box8SubstitutePayments: 10,
  box9CropInsuranceProceeds: 600,
  box10GrossProceedsAttorney: 600,
  box11FishForResale: 600,
  box12Section409ADeferrals: 600,
  box13ExcessGoldenParachute: 600,
  box14NonqualifiedDeferred: 600,
} as const;

/** Empty zero-filled boxes for fresh accumulation. */
function emptyBoxes(): Form1099MiscBoxes {
  return {
    box1Rents: 0,
    box2Royalties: 0,
    box3OtherIncome: 0,
    box4FitWithheld: 0,
    box5FishingBoatProceeds: 0,
    box6MedicalHealthcarePayments: 0,
    box7DirectSales: false,
    box8SubstitutePayments: 0,
    box9CropInsuranceProceeds: 0,
    box10GrossProceedsAttorney: 0,
    box11FishForResale: 0,
    box12Section409ADeferrals: 0,
    box13ExcessGoldenParachute: 0,
    box14NonqualifiedDeferred: 0,
    stateLines: [],
    sourceItemCount: 0,
  };
}

/**
 * Aggregates 1099-MISC boxes for one contractor / one tax year.
 *
 * Routes grossPay to Box 3 (Other income) by default. Future per-vendor
 * box-mapping config can override this without changing the caller.
 */
export async function aggregateF1099MiscPayments(
  tx: Tx,
  associateId: string,
  taxYear: number,
): Promise<Form1099MiscBoxes> {
  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const yearEndExclusive = new Date(Date.UTC(taxYear + 1, 0, 1));

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

  const boxes = emptyBoxes();
  const stateBuckets = new Map<string, { tax: number; income: number }>();

  for (const item of items) {
    const gross = Number(item.grossPay);
    boxes.box3OtherIncome += gross;
    boxes.box4FitWithheld += Number(item.federalWithholding);

    if (item.taxState) {
      const b = stateBuckets.get(item.taxState) ?? { tax: 0, income: 0 };
      b.tax += Number(item.stateWithholding);
      b.income += gross;
      stateBuckets.set(item.taxState, b);
    }
  }

  boxes.box3OtherIncome = round2(boxes.box3OtherIncome);
  boxes.box4FitWithheld = round2(boxes.box4FitWithheld);
  boxes.stateLines = [...stateBuckets.entries()]
    .map(([state, b]) => ({
      state,
      stateTaxWithheld: round2(b.tax),
      stateIncome: round2(b.income),
    }))
    .filter((l) => l.stateTaxWithheld !== 0 || l.stateIncome !== 0)
    .sort((a, b) => a.state.localeCompare(b.state));
  boxes.sourceItemCount = items.length;

  return boxes;
}

/**
 * True if this Form1099MiscBoxes total meets the IRS reporting bar.
 * Any Box 4 backup withholding triggers regardless; otherwise the per-
 * box thresholds apply.
 */
export function meetsF1099MiscThreshold(boxes: Form1099MiscBoxes): boolean {
  if (boxes.box4FitWithheld > 0) return true;
  const t = F1099_MISC_REPORTING_THRESHOLDS;
  return (
    boxes.box1Rents >= t.box1Rents ||
    boxes.box2Royalties >= t.box2Royalties ||
    boxes.box3OtherIncome >= t.box3OtherIncome ||
    boxes.box5FishingBoatProceeds >= t.box5FishingBoatProceeds ||
    boxes.box6MedicalHealthcarePayments >= t.box6MedicalHealthcarePayments ||
    boxes.box8SubstitutePayments >= t.box8SubstitutePayments ||
    boxes.box9CropInsuranceProceeds >= t.box9CropInsuranceProceeds ||
    boxes.box10GrossProceedsAttorney >= t.box10GrossProceedsAttorney ||
    boxes.box11FishForResale >= t.box11FishForResale ||
    boxes.box12Section409ADeferrals >= t.box12Section409ADeferrals ||
    boxes.box13ExcessGoldenParachute >= t.box13ExcessGoldenParachute ||
    boxes.box14NonqualifiedDeferred >= t.box14NonqualifiedDeferred
  );
}

/**
 * Returns contractor associate IDs that meet 1099-MISC reporting
 * thresholds for the year, scoped to one client (or all if clientId is
 * null). Same shape as listF1099NecEligibleAssociates so callers can
 * dispatch on form kind.
 */
export async function listF1099MiscEligibleAssociates(
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
    const boxes = await aggregateF1099MiscPayments(tx, c.associateId, taxYear);
    if (meetsF1099MiscThreshold(boxes)) {
      eligible.push(c.associateId);
    }
  }
  return eligible;
}
