-- Brief 1A-2 — one definition of active. Additive.
--
-- The activity window and the company workweek become settings; the
-- reconciliation report can persist its totals so the Headcount screen
-- shows the variance beside today's numbers.

ALTER TABLE "OrgSetting" ADD COLUMN IF NOT EXISTS "activeWindowDays" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "OrgSetting" ADD COLUMN IF NOT EXISTS "weekStartsOn" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "OrgSetting" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(64) NOT NULL DEFAULT 'America/New_York';

CREATE TABLE IF NOT EXISTS "ReconciliationSnapshot" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "periodStart"     DATE NOT NULL,
  "periodEnd"       DATE NOT NULL,
  "ranAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "windowDays"      INTEGER NOT NULL,
  "platformActive"  INTEGER NOT NULL,
  "platformPaid"    INTEGER NOT NULL,
  "payrollPaid"     INTEGER,
  "platformHours"   DECIMAL(12,2) NOT NULL,
  "payrollHours"    DECIMAL(12,2),
  "platformGross"   DECIMAL(14,2) NOT NULL,
  "payrollGross"    DECIMAL(14,2),
  "varianceLines"   INTEGER,
  "payrollProvided" BOOLEAN NOT NULL DEFAULT false,
  "notes"           VARCHAR(1000),
  "tenantId"        UUID DEFAULT '00000000-0000-4000-8000-000000000001',
  CONSTRAINT "ReconciliationSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ReconciliationSnapshot_periodEnd_idx" ON "ReconciliationSnapshot"("periodEnd" DESC);
CREATE INDEX IF NOT EXISTS "ReconciliationSnapshot_tenantId_idx" ON "ReconciliationSnapshot"("tenantId");
