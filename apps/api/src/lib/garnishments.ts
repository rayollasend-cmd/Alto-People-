// Wave 4.1 — Garnishment auto-application during payroll runs.
//
// Walks ACTIVE garnishments for an associate and computes how much to
// deduct from a single paystub. Caller persists the deductions and adjusts
// netPay; this module is pure (no DB), so it's trivially testable.
//
// Federal CCPA caps (Consumer Credit Protection Act, 15 U.S.C. § 1673):
//   - Ordinary creditor garnishment: 25% of disposable earnings, OR the
//     amount by which weekly disposable exceeds 30 × federal min wage,
//     whichever is less. We use the 25% rule (the federal min-wage carveout
//     would only matter at extremely low wages).
//   - Child support: 50% (with second family) or 60% (without), +5% if
//     12+ weeks in arrears. We use 60% as a conservative single-tier.
//   - Tax levy: governed by IRS Publication 1494, computed differently;
//     the agency provides a per-pay-period cap on the levy notice.
//   - Student loan (federal): 15% of disposable earnings.
//   - Bankruptcy: court-ordered amount only, no statutory cap.
//
// "Disposable earnings" = gross - mandatory deductions (FIT + FICA +
// Medicare + SIT). Pre-tax benefits are NOT deducted from disposable per
// federal rule, though some states differ. We follow the federal definition.

import type { GarnishmentKind } from '@prisma/client';
import { round2 } from './payroll.js';

export interface GarnishmentRule {
  id: string;
  kind: GarnishmentKind;
  /** Flat $ per pay period. Exclusive with percentOfDisp on the row. */
  amountPerRun: number | null;
  /** Decimal fraction (0.25 = 25%) of disposable earnings. */
  percentOfDisp: number | null;
  /** Lifetime cap; once amountWithheld + new ≥ totalCap, the garnishment closes. */
  totalCap: number | null;
  amountWithheld: number;
  /** Lower priority numbers run first. */
  priority: number;
}

export interface GarnishmentInput {
  /** Per-CCPA disposable earnings for this paycheck. */
  disposableEarnings: number;
  /** Active garnishments for this associate (any order). */
  rules: GarnishmentRule[];
}

export interface GarnishmentResult {
  /** Per-rule deductions applied this paycheck (in priority order). */
  deductions: Array<{ garnishmentId: string; amount: number; reachedCap: boolean }>;
  /** Sum of all per-rule deductions. */
  total: number;
}

/** Per-CCPA cap (fraction of disposable) by garnishment kind. */
function capFraction(kind: GarnishmentKind): number {
  switch (kind) {
    case 'CHILD_SUPPORT': return 0.60;
    case 'TAX_LEVY':      return 1.00; // agency-provided cap on the levy notice
    case 'STUDENT_LOAN':  return 0.15;
    case 'BANKRUPTCY':    return 1.00; // court-ordered only
    case 'CREDITOR':      return 0.25;
    case 'OTHER':         return 0.25;
  }
}

/**
 * Compute the per-rule deduction amounts for one paycheck. Pure function:
 * returns the list of (garnishmentId, amount). Caller applies & persists.
 *
 * Algorithm:
 *   1. Sort by priority asc (most-senior first).
 *   2. For each rule:
 *      - Want = amountPerRun OR (percentOfDisp × disposable).
 *      - Cap by per-kind CCPA fraction × disposable.
 *      - Cap by remaining lifetime totalCap.
 *      - Cap by remaining disposable AFTER prior rules in this paycheck
 *        (so two 25% creditor garnishments can't sum to 50%).
 *      - Round to 2 decimals.
 */
export function computeGarnishmentDeductions(input: GarnishmentInput): GarnishmentResult {
  const sorted = [...input.rules].sort((a, b) => a.priority - b.priority);
  const deductions: GarnishmentResult['deductions'] = [];
  let remaining = input.disposableEarnings;
  let total = 0;

  for (const r of sorted) {
    if (remaining <= 0) break;

    const want =
      r.amountPerRun !== null
        ? r.amountPerRun
        : r.percentOfDisp !== null
        ? input.disposableEarnings * r.percentOfDisp
        : 0;
    if (want <= 0) continue;

    const ccpaCap = input.disposableEarnings * capFraction(r.kind);
    const lifetimeRemaining = r.totalCap !== null
      ? Math.max(0, r.totalCap - r.amountWithheld)
      : Infinity;

    const amount = round2(Math.min(want, ccpaCap, lifetimeRemaining, remaining));
    if (amount <= 0) continue;

    const reachedCap =
      r.totalCap !== null && r.amountWithheld + amount >= r.totalCap - 0.005;

    deductions.push({ garnishmentId: r.id, amount, reachedCap });
    total += amount;
    remaining = round2(remaining - amount);
  }

  return { deductions, total: round2(total) };
}
