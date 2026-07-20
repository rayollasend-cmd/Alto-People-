-- Tier-1 — paper-check register. Global serial check numbers, one check
-- per PayrollItem.
CREATE TABLE "PayCheck" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "checkNumber" SERIAL NOT NULL,
    "payrollItemId" UUID NOT NULL,
    "payeeName" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "memo" TEXT,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PayCheck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayCheck_checkNumber_key" ON "PayCheck"("checkNumber");
CREATE UNIQUE INDEX "PayCheck_payrollItemId_key" ON "PayCheck"("payrollItemId");
CREATE INDEX "PayCheck_issuedAt_idx" ON "PayCheck"("issuedAt");

ALTER TABLE "PayCheck" ADD CONSTRAINT "PayCheck_payrollItemId_fkey"
    FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
