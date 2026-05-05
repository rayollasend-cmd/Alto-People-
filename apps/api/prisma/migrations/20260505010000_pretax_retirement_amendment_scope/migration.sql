-- Gap 1 — Relax the pre-tax-retirement subset CHECK so it applies only
-- to non-amendment rows.
--
-- Amendment PayrollItems carry SIGNED DELTAS, so a negative
-- preTaxDeductions delta combined with a zero preTaxRetirement delta
-- (preTaxRetirement: 0  ≤  preTaxDeductions: -50) trips the original
-- check even though the row is mathematically valid as a delta. The
-- subset invariant only makes sense on absolute (non-amendment) rows
-- where amendsItemId IS NULL.

ALTER TABLE "PayrollItem"
  DROP CONSTRAINT "PayrollItem_pretax_retirement_subset_chk";

ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "PayrollItem_pretax_retirement_subset_chk"
  CHECK (
    "amendsItemId" IS NOT NULL
    OR "preTaxRetirement" <= "preTaxDeductions"
  );
