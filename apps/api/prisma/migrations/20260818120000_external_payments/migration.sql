-- Audit documentation for externally-run payroll. Payroll is currently
-- processed outside Alto, so HR records each pay period per associate and
-- attaches evidence (paystub PDF, cleared check, processor report) as
-- PAYSTUB DocumentRecords linked back to the period.

ALTER TYPE "DocumentKind" ADD VALUE 'PAYSTUB';

CREATE TYPE "ExternalPaymentMethod" AS ENUM ('DIRECT_DEPOSIT', 'CHECK', 'CASH', 'PAYROLL_PROVIDER', 'OTHER');

CREATE TABLE "ExternalPayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "payDate" DATE,
    "grossAmount" DECIMAL(12,2),
    "netAmount" DECIMAL(12,2),
    "method" "ExternalPaymentMethod" NOT NULL DEFAULT 'OTHER',
    "reference" VARCHAR(120),
    "note" VARCHAR(500),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "ExternalPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExternalPayment_associateId_periodEnd_idx" ON "ExternalPayment"("associateId", "periodEnd" DESC);
CREATE INDEX "ExternalPayment_deletedAt_idx" ON "ExternalPayment"("deletedAt");

ALTER TABLE "ExternalPayment"
  ADD CONSTRAINT "ExternalPayment_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ExternalPayment"
  ADD CONSTRAINT "ExternalPayment_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Evidence link. SET NULL so deleting a payment record never destroys the
-- audit artifact — the file stays in the associate's vault.
ALTER TABLE "DocumentRecord" ADD COLUMN "externalPaymentId" UUID;

CREATE INDEX "DocumentRecord_externalPaymentId_idx" ON "DocumentRecord"("externalPaymentId");

ALTER TABLE "DocumentRecord"
  ADD CONSTRAINT "DocumentRecord_externalPaymentId_fkey"
  FOREIGN KEY ("externalPaymentId") REFERENCES "ExternalPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
