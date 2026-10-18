-- The pre-payroll review: before a run's money moves, an accountant reads
-- the review report (every paycheck, totals, cash needed, taxes owed, the
-- swings since last payroll) and signs off on that exact version of the
-- numbers. The fingerprint is a hash of every paycheck's amounts; when any
-- of them changes after the sign-off, the sign-off no longer matches and
-- the run can't be paid until someone reviews it again.
--
--   OrgSetting.payrollReviewRequired  the gate, on by default. A second
--                                     person signs where one exists.

CREATE TABLE "PayrollRunReview" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "payrollRunId" UUID NOT NULL,
  "fingerprint"  VARCHAR(64) NOT NULL,
  "signedById"   UUID,
  "signedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "note"         VARCHAR(1000),
  "soleReviewer" BOOLEAN NOT NULL DEFAULT false,
  "totals"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "PayrollRunReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollRunReview_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PayrollRunReview_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "PayrollRunReview_payrollRunId_signedAt_idx" ON "PayrollRunReview"("payrollRunId", "signedAt");
CREATE INDEX "PayrollRunReview_tenantId_idx" ON "PayrollRunReview"("tenantId");

ALTER TABLE "OrgSetting" ADD COLUMN "payrollReviewRequired" BOOLEAN NOT NULL DEFAULT true;
