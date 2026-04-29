-- Wave 4.2 — Post-tax deductions snapshot on PayrollItem.
ALTER TABLE "PayrollItem"
  ADD COLUMN "postTaxDeductions" DECIMAL(12, 2) NOT NULL DEFAULT 0;
