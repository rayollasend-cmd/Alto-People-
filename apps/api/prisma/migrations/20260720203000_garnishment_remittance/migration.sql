-- Tier-1 — garnishment remittance queue: withheld money must reach the payee.
CREATE TYPE "GarnishmentRemittanceStatus" AS ENUM ('PENDING', 'SENT');

CREATE TABLE "GarnishmentRemittance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payrollRunId" UUID NOT NULL,
    "payeeName" TEXT NOT NULL,
    "payeeAddress" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "GarnishmentRemittanceStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMPTZ(6),
    "sentById" UUID,
    "reference" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GarnishmentRemittance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GarnishmentRemittance_payrollRunId_payeeName_key"
    ON "GarnishmentRemittance"("payrollRunId", "payeeName");
CREATE INDEX "GarnishmentRemittance_status_idx" ON "GarnishmentRemittance"("status");

ALTER TABLE "GarnishmentRemittance" ADD CONSTRAINT "GarnishmentRemittance_payrollRunId_fkey"
    FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GarnishmentRemittance" ADD CONSTRAINT "GarnishmentRemittance_sentById_fkey"
    FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GarnishmentDeduction" ADD COLUMN "remittanceId" UUID;
CREATE INDEX "GarnishmentDeduction_remittanceId_idx" ON "GarnishmentDeduction"("remittanceId");
ALTER TABLE "GarnishmentDeduction" ADD CONSTRAINT "GarnishmentDeduction_remittanceId_fkey"
    FOREIGN KEY ("remittanceId") REFERENCES "GarnishmentRemittance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
