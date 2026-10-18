// Wave 4.1 — Garnishment auto-application during payroll runs.
//
// Walks ACTIVE garnishments for an associate and computes how much to
// deduct from a single paystub. Caller persists the deductions and adjusts
// netPay; this module is pure (no DB), so it's trivially testable.
//
// Federal CCPA caps (Consumer Credit Protection Act, 15 U.S.C. § 1673):
//   - Ordinary creditor garnishment: 25% of disposable earnings, OR the
//     amount by which weekly disposable exceeds 30 × federal min wage,
//     whichever is less (both applied when the pay frequency is known).
//   - Child support: 50% (with second family) or 60% (without), +5% if
//     12+ weeks in arrears (both applied; see lib/garnishmentEngine).
//   - Tax levy: governed by IRS Publication 1494, computed differently;
//     the agency provides a per-pay-period cap on the levy notice.
//   - Student loan (federal): 15% of disposable earnings.
//   - Bankruptcy: court-ordered amount only, no statutory cap.
//
// "Disposable earnings" = gross - mandatory deductions (FIT + FICA +
// Medicare + SIT). Pre-tax benefits are NOT deducted from disposable per
// federal rule, though some states differ. We follow the federal definition.

import type { GarnishmentKind } from '@prisma/client';
import { computeWithholding, type EngineOrder, type PayFrequency, type StateRule } from './garnishmentEngine.js';

/*
 * The rules themselves live in lib/garnishmentEngine (support allocation,
 * the CCPA limits including the 30 × minimum-wage floor and the 25%
 * non-support ceiling, Publication 1494 levies, state fees). This module
 * keeps the original entry point for callers that pass the simple shape.
 */

export interface GarnishmentRule extends Omit<EngineOrder, 'amountPerRun' | 'percentOfDisp' | 'totalCap' | 'amountWithheld'> {
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
  /** The paycheck's frequency — turns on the 30 × federal minimum wage floor. */
  payFrequency?: PayFrequency;
  /** Federal levy: take-home pay before the levy. */
  takeHomePay?: number;
  stateRules?: Record<string, StateRule>;
  feeAlreadyCharged?: Set<string>;
}

export interface GarnishmentResult {
  /** Per-rule deductions applied this paycheck (in priority order). */
  deductions: Array<{ garnishmentId: string; amount: number; reachedCap: boolean; adminFee: number; note: string | null }>;
  /** Sum of all per-rule deductions (fees excluded). */
  total: number;
  /** The employer's processing fees the states allow, kept not remitted. */
  adminFeeTotal: number;
}

/** Compute the per-order deduction amounts for one paycheck. Pure. */
export function computeGarnishmentDeductions(input: GarnishmentInput): GarnishmentResult {
  const r = computeWithholding({
    disposableEarnings: input.disposableEarnings,
    takeHomePay: input.takeHomePay,
    payFrequency: input.payFrequency,
    orders: input.rules,
    stateRules: input.stateRules,
    feeAlreadyCharged: input.feeAlreadyCharged,
  });
  return {
    deductions: r.deductions.map((d) => ({ garnishmentId: d.garnishmentId, amount: d.amount, reachedCap: d.reachedCap, adminFee: d.adminFee, note: d.note })),
    total: r.total,
    adminFeeTotal: r.adminFeeTotal,
  };
}
