-- Payroll wave A (2026-10-21): the period ledger's off-cycle runs that pay approved time,
-- readiness requests, and group-term life coverage for imputed income.

-- AlterEnum
ALTER TYPE "PayrollEarningKind" ADD VALUE IF NOT EXISTS 'IMPUTED_INCOME';

-- AlterTable
ALTER TABLE "PayrollRun" ADD COLUMN "includesApprovedTime" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "BenefitsEnrollment" ADD COLUMN "lifeCoverageCents" INTEGER;

-- CreateTable
CREATE TABLE "PayrollReadinessRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "associateId" UUID NOT NULL,
    "items" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedById" UUID,
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payrollRunId" UUID,

    CONSTRAINT "PayrollReadinessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollReadinessRequest_associateId_requestedAt_idx" ON "PayrollReadinessRequest"("associateId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "PayrollReadinessRequest_tenantId_idx" ON "PayrollReadinessRequest"("tenantId");

-- AddForeignKey
ALTER TABLE "PayrollReadinessRequest" ADD CONSTRAINT "PayrollReadinessRequest_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollReadinessRequest" ADD CONSTRAINT "PayrollReadinessRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollReadinessRequest" ADD CONSTRAINT "PayrollReadinessRequest_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
