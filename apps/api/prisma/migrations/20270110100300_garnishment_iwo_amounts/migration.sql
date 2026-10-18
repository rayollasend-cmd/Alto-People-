-- An e-IWO order states its amounts as current / past-due / medical support per
-- its own frequency, and a federal levy is figured from Publication 1494; neither
-- has a flat per-run amount or a percent. Keep "one of the two" for manual
-- orders and allow the IWO / levy shapes alongside (lib/garnishmentEngine).
ALTER TABLE "Garnishment" DROP CONSTRAINT IF EXISTS "Garnishment_amount_check";
ALTER TABLE "Garnishment" ADD CONSTRAINT "Garnishment_amount_check" CHECK (
  ("amountPerRun" IS NOT NULL AND "percentOfDisp" IS NULL)
  OR ("amountPerRun" IS NULL AND "percentOfDisp" IS NOT NULL)
  OR (
    "amountPerRun" IS NULL AND "percentOfDisp" IS NULL
    AND ("currentSupport" IS NOT NULL OR "pastDueSupport" IS NOT NULL OR "medicalSupport" IS NOT NULL OR "levyFilingStatus" IS NOT NULL)
  )
);
