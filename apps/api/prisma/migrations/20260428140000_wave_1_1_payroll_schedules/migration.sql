-- Wave 1.1 — Payroll schedules. Named cadence + anchor date that drives the
-- payroll run wizard's "next period" computation and tax annualization.

-- CreateEnum
CREATE TYPE "PayrollFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "PayrollSchedule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID,
    "name" TEXT NOT NULL,
    "frequency" "PayrollFrequency" NOT NULL,
    "anchorDate" DATE NOT NULL,
    "payDateOffsetDays" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PayrollSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollSchedule_clientId_isActive_idx" ON "PayrollSchedule"("clientId", "isActive");
CREATE INDEX "PayrollSchedule_deletedAt_idx" ON "PayrollSchedule"("deletedAt");

-- AlterTable: associate <-> schedule assignment
ALTER TABLE "Associate" ADD COLUMN "payrollScheduleId" UUID;
CREATE INDEX "Associate_payrollScheduleId_idx" ON "Associate"("payrollScheduleId");

-- AddForeignKey
ALTER TABLE "PayrollSchedule" ADD CONSTRAINT "PayrollSchedule_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Associate" ADD CONSTRAINT "Associate_payrollScheduleId_fkey"
  FOREIGN KEY ("payrollScheduleId") REFERENCES "PayrollSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
