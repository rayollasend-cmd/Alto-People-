// Gap 1 — W-2c (corrected wage statement) helpers.
//
// A W-2c carries BOTH the previously reported amounts (from the original
// W-2 the IRS already received) and the corrected amounts. The IRS / SSA
// matches against the previous values to identify what changed; finance
// keeps the corrected values as the new authoritative figures.
//
// We don't re-derive `previous` — that's the snapshot stored on the
// original TaxForm.amounts. `corrected` either comes from the caller
// (manual correction) or is recomputed via aggregateW2Wages — from the
// same itemized deductions and tax-engine lines as the W-2 — against the
// current state of payroll items (the common case after an AMENDMENT
// run posts new wages to a year that's already been W-2'd).

import type { W2Boxes } from './w2Aggregator.js';

/**
 * The shape stored on TaxForm.amounts for a W2C kind. Each box appears
 * twice (previous + corrected) so the W-2c PDF and EFW2C generator can
 * render both columns without joining back to the original row.
 */
export interface W2cAmounts {
  previous: W2Boxes;
  corrected: W2Boxes;
}

/** True if any box / state line differs between previous and corrected. */
export function hasW2cDelta(a: W2Boxes, b: W2Boxes): boolean {
  if (a.box1Wages !== b.box1Wages) return true;
  if (a.box2FitWithheld !== b.box2FitWithheld) return true;
  if (a.box3SsWages !== b.box3SsWages) return true;
  if (a.box4SsTax !== b.box4SsTax) return true;
  if (a.box5MedicareWages !== b.box5MedicareWages) return true;
  if (a.box6MedicareTax !== b.box6MedicareTax) return true;
  // Boxes 7, 10, 12 and 14b (forms stored before these existed read as empty).
  if ((a.box7SsTips ?? 0) !== (b.box7SsTips ?? 0)) return true;
  if ((a.box10DependentCare ?? 0) !== (b.box10DependentCare ?? 0)) return true;
  const codes = (x: W2Boxes) => (x.box12 ?? []).map((e) => `${e.code}:${e.amount}`).join('|');
  if (codes(a) !== codes(b)) return true;
  if ((a.box14bTippedOccupationCodes ?? []).join('|') !== (b.box14bTippedOccupationCodes ?? []).join('|')) return true;
  // Boxes 13 (retirement plan), 14a and 18–20 (stored before these existed read as empty).
  if (Boolean(a.box13RetirementPlan) !== Boolean(b.box13RetirementPlan)) return true;
  const other = (x: W2Boxes) => (x.box14Other ?? []).map((e) => `${e.label}:${e.amount}`).sort().join('|');
  if (other(a) !== other(b)) return true;
  const locals = (x: W2Boxes) => (x.localLines ?? []).map((l) => `${l.state}|${l.code}:${l.localWages}:${l.localIncomeTax}`).sort().join('|');
  if (locals(a) !== locals(b)) return true;

  // States: a different set of state codes counts as a delta even if
  // the per-state numbers happen to match.
  const aKeys = new Set(a.stateLines.map((s) => s.state));
  const bKeys = new Set(b.stateLines.map((s) => s.state));
  if (aKeys.size !== bKeys.size) return true;
  for (const k of aKeys) if (!bKeys.has(k)) return true;
  for (const stateLine of a.stateLines) {
    const other = b.stateLines.find((s) => s.state === stateLine.state);
    if (!other) return true;
    if (other.stateWages !== stateLine.stateWages) return true;
    if (other.stateIncomeTax !== stateLine.stateIncomeTax) return true;
  }
  return false;
}
