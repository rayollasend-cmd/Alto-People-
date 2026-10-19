-- Paper checks, done properly.
--
--   PayrollItemPayoutOverride  "pay this paycheck by paper check this time":
--                              set by payroll (or approved from the
--                              associate's own request), cleared before
--                              payout. One row per paycheck; clearing keeps
--                              the row with clearedAt so the record stays.
--   PayCheck                   gains its lifecycle: printed (when, by whom,
--                              how many times), voided (why, by whom),
--                              reissued from an earlier check, stop payment,
--                              and positive-pay export. A paycheck can now
--                              have several checks over time (a void and a
--                              reissue) but only one live one.
--   CheckSettings              per tenant: which bank account checks are
--                              drawn on, the bank's name/address/fraction,
--                              printer calibration offsets, the facsimile
--                              signature, the two-signature threshold.

ALTER TYPE "ApprovalRequestKind" ADD VALUE IF NOT EXISTS 'PAY_BY_CHECK';

CREATE TABLE "PayrollItemPayoutOverride" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"          UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "payrollItemId"     UUID NOT NULL,
  "method"            VARCHAR(10) NOT NULL DEFAULT 'CHECK',
  "reason"            VARCHAR(500) NOT NULL,
  "source"            VARCHAR(12) NOT NULL DEFAULT 'PAYROLL',
  "requestedById"     UUID,
  "approvalRequestId" UUID,
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "clearedAt"         TIMESTAMPTZ(6),
  "clearedById"       UUID,
  "clearReason"       VARCHAR(500),
  CONSTRAINT "PayrollItemPayoutOverride_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollItemPayoutOverride_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PayrollItemPayoutOverride_method_check" CHECK ("method" IN ('CHECK')),
  CONSTRAINT "PayrollItemPayoutOverride_source_check" CHECK ("source" IN ('PAYROLL', 'ASSOCIATE'))
);
CREATE UNIQUE INDEX "PayrollItemPayoutOverride_payrollItemId_key" ON "PayrollItemPayoutOverride"("payrollItemId");
CREATE INDEX "PayrollItemPayoutOverride_tenantId_idx" ON "PayrollItemPayoutOverride"("tenantId");

-- A paycheck may carry a voided check and its reissue; only one live check at a time.
DROP INDEX IF EXISTS "PayCheck_payrollItemId_key";
CREATE INDEX "PayCheck_payrollItemId_idx" ON "PayCheck"("payrollItemId");
CREATE UNIQUE INDEX "PayCheck_payrollItemId_live_key" ON "PayCheck"("payrollItemId") WHERE "voidedAt" IS NULL;

ALTER TABLE "PayCheck"
  ADD COLUMN "payeeAddress"        JSONB,
  ADD COLUMN "printedAt"           TIMESTAMPTZ(6),
  ADD COLUMN "printedById"         UUID,
  ADD COLUMN "printCount"          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "voidReason"          VARCHAR(500),
  ADD COLUMN "voidedById"          UUID,
  ADD COLUMN "reissuedFromId"      UUID,
  ADD COLUMN "stopPaymentAt"       TIMESTAMPTZ(6),
  ADD COLUMN "stopPaymentById"     UUID,
  ADD COLUMN "stopPaymentReason"   VARCHAR(500),
  ADD COLUMN "stopPaymentRef"      VARCHAR(80),
  ADD COLUMN "positivePayAt"       TIMESTAMPTZ(6),
  ADD COLUMN "positivePayVoidAt"   TIMESTAMPTZ(6);

CREATE TABLE "CheckSettings" (
  "id"                        UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"                  UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "bankAccountId"             UUID,
  "bankName"                  VARCHAR(120),
  "bankAddress"               VARCHAR(200),
  "fractionalRouting"         VARCHAR(20),
  "offsetXPt"                 DOUBLE PRECISION NOT NULL DEFAULT 0,
  "offsetYPt"                 DOUBLE PRECISION NOT NULL DEFAULT 0,
  "signatureImage"            BYTEA,
  "signatureContentType"      VARCHAR(40),
  "signatureSignerName"       VARCHAR(120),
  "twoSignatureOverCents"     BIGINT,
  "voidAfterDays"             INTEGER NOT NULL DEFAULT 90,
  "updatedById"               UUID,
  "createdAt"                 TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"                 TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "CheckSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CheckSettings_offsets_check" CHECK ("offsetXPt" BETWEEN -36 AND 36 AND "offsetYPt" BETWEEN -36 AND 36),
  CONSTRAINT "CheckSettings_voidAfter_check" CHECK ("voidAfterDays" BETWEEN 30 AND 365)
);
CREATE UNIQUE INDEX "CheckSettings_tenantId_key" ON "CheckSettings"("tenantId");
