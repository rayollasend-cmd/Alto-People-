-- Tier-1 — federal tax deposit ledger + employer deposit schedule.
ALTER TABLE "SubmitterProfile"
    ADD COLUMN "depositSchedule" VARCHAR(12) NOT NULL DEFAULT 'MONTHLY';

CREATE TYPE "TaxDepositKind" AS ENUM ('FED_941', 'FUTA');
CREATE TYPE "TaxDepositStatus" AS ENUM ('PENDING', 'PAID');

CREATE TABLE "TaxDeposit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "TaxDepositKind" NOT NULL,
    "scheduleUsed" VARCHAR(12) NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "payrollRunId" UUID,
    "liabilityDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "breakdown" JSONB NOT NULL,
    "status" "TaxDepositStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMPTZ(6),
    "paidById" UUID,
    "confirmationNumber" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TaxDeposit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaxDeposit_payrollRunId_key" ON "TaxDeposit"("payrollRunId");
CREATE INDEX "TaxDeposit_status_dueDate_idx" ON "TaxDeposit"("status", "dueDate");
CREATE INDEX "TaxDeposit_kind_periodLabel_idx" ON "TaxDeposit"("kind", "periodLabel");

ALTER TABLE "TaxDeposit" ADD CONSTRAINT "TaxDeposit_payrollRunId_fkey"
    FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaxDeposit" ADD CONSTRAINT "TaxDeposit_paidById_fkey"
    FOREIGN KEY ("paidById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
