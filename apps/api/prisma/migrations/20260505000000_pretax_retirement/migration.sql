-- Gap 1 — Pre-tax categorization split.
--
-- Adds a per-item bucket for the slice of pre-tax that reduces FIT but
-- NOT FICA/Medicare. Today's `preTaxDeductions` keeps its meaning as the
-- total; `preTaxRetirement` is the 401(k)/403(b) sub-bucket we now
-- separate out so payroll-tax math + W-2 box math handle it correctly.
--
-- IRS rules:
--   · Section 125 (cafeteria plans — health/dental/vision/HSA/FSA premiums)
--     reduce wages for Box 1, Box 3, AND Box 5. Today's behaviour.
--   · Traditional 401(k) / 403(b) reduce Box 1 only. Box 3 and Box 5 are
--     computed against the un-retirement-reduced wage base. Without this
--     split, a 401(k) deduction would silently leak into FICA/Medicare
--     wages on the W-2.
--
-- Existing rows default to 0 — equivalent to "no retirement deduction yet"
-- which matches reality (we don't have any 401(k) plans live today).

ALTER TABLE "PayrollItem"
  ADD COLUMN "preTaxRetirement" DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- Sanity invariant: the retirement bucket can never exceed total pre-tax.
ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "PayrollItem_pretax_retirement_subset_chk"
  CHECK ("preTaxRetirement" <= "preTaxDeductions");
