-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'FINALIZED', 'DISBURSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollItemStatus" AS ENUM ('PENDING', 'DISBURSED', 'FAILED', 'HELD');

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "totalGross" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" UUID,
    "finalizedAt" TIMESTAMPTZ(6),
    "disbursedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payrollRunId" UUID NOT NULL,
    "associateId" UUID NOT NULL,
    "hoursWorked" DECIMAL(8,2) NOT NULL,
    "hourlyRate" DECIMAL(8,2) NOT NULL,
    "grossPay" DECIMAL(12,2) NOT NULL,
    "federalWithholding" DECIMAL(12,2) NOT NULL,
    "netPay" DECIMAL(12,2) NOT NULL,
    "status" "PayrollItemStatus" NOT NULL DEFAULT 'PENDING',
    "disbursementRef" TEXT,
    "disbursedAt" TIMESTAMPTZ(6),
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollRun_clientId_periodStart_idx" ON "PayrollRun"("clientId", "periodStart");

-- CreateIndex
CREATE INDEX "PayrollRun_status_idx" ON "PayrollRun"("status");

-- CreateIndex
CREATE INDEX "PayrollItem_associateId_idx" ON "PayrollItem"("associateId");

-- CreateIndex
CREATE INDEX "PayrollItem_status_idx" ON "PayrollItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollItem_payrollRunId_associateId_key" ON "PayrollItem"("payrollRunId", "associateId");

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
