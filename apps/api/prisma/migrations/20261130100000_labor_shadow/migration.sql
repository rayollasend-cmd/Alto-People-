-- Brief 2-2 step 3 — the labor rules engine in shadow: each finalized payroll
-- run recomputed beside what it paid, and every associate whose result differs.
-- Additive; nothing pays from these tables.

-- CreateTable
CREATE TABLE "LaborShadowRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "payrollRunId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "associates" INTEGER NOT NULL,
    "differences" INTEGER NOT NULL,
    "amountDifference" DECIMAL(12,2) NOT NULL,
    "penaltyHours" DECIMAL(10,2) NOT NULL,
    "ranAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LaborShadowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaborShadowDiff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "shadowRunId" UUID NOT NULL,
    "associateId" UUID NOT NULL,
    "paidRegular" DECIMAL(10,2) NOT NULL,
    "paidOvertime" DECIMAL(10,2) NOT NULL,
    "engineRegular" DECIMAL(10,2) NOT NULL,
    "engineOvertime" DECIMAL(10,2) NOT NULL,
    "engineDouble" DECIMAL(10,2) NOT NULL,
    "hourlyRate" DECIMAL(10,2) NOT NULL,
    "amountDifference" DECIMAL(12,2) NOT NULL,
    "penaltyHours" DECIMAL(10,2) NOT NULL,
    "reasons" JSONB NOT NULL,
    "fingerprints" TEXT[],

    CONSTRAINT "LaborShadowDiff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LaborShadowRun_payrollRunId_key" ON "LaborShadowRun"("payrollRunId");

-- CreateIndex
CREATE INDEX "LaborShadowRun_tenantId_ranAt_idx" ON "LaborShadowRun"("tenantId", "ranAt");

-- CreateIndex
CREATE INDEX "LaborShadowDiff_shadowRunId_idx" ON "LaborShadowDiff"("shadowRunId");

-- CreateIndex
CREATE INDEX "LaborShadowDiff_associateId_idx" ON "LaborShadowDiff"("associateId");

-- AddForeignKey
ALTER TABLE "LaborShadowRun" ADD CONSTRAINT "LaborShadowRun_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaborShadowDiff" ADD CONSTRAINT "LaborShadowDiff_shadowRunId_fkey" FOREIGN KEY ("shadowRunId") REFERENCES "LaborShadowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaborShadowDiff" ADD CONSTRAINT "LaborShadowDiff_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
