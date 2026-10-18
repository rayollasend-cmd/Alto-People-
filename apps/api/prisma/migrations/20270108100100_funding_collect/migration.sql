-- Whether the funding debit also collects the run's taxes and garnishment
-- remittances (when we pay them on the tenant's behalf).
ALTER TABLE "PayrollBankingProfile"
  ADD COLUMN "collectTaxes"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "collectGarnishments" BOOLEAN NOT NULL DEFAULT false;
