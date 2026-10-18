-- The pay ↔ bill ↔ margin link (BEYOND).
--   ClientBillingTerms  per-client contract terms, effective-dated: how retro
--                       pay is rebilled, whether overtime bills at the
--                       multiplier, which premiums are billable and how.
--   BillingAdjustment   a line owed to (or by) a client that payroll created:
--                       retro pay rebilled, or a premium billed by contract.
--                       It rides on the client's next statement and is
--                       claimed by the statement that finalizes it.

ALTER TYPE "ApprovalRequestKind" ADD VALUE IF NOT EXISTS 'BILLING_ADJUSTMENT';

CREATE TABLE "ClientBillingTerms" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "clientId"         UUID NOT NULL,
  "effectiveFrom"    DATE NOT NULL,
  "retroRebill"      VARCHAR(12) NOT NULL DEFAULT 'REVIEW',
  "overtimeBilling"  VARCHAR(12) NOT NULL DEFAULT 'MULTIPLIED',
  "premiumRules"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "defaultMarkupPct" DECIMAL(6,2),
  "notes"            VARCHAR(500),
  "updatedById"      UUID,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ClientBillingTerms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClientBillingTerms_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ClientBillingTerms_clientId_effectiveFrom_key" ON "ClientBillingTerms"("clientId", "effectiveFrom");
CREATE INDEX "ClientBillingTerms_tenantId_idx" ON "ClientBillingTerms"("tenantId");

CREATE TABLE "BillingAdjustment" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"            UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "clientId"            UUID NOT NULL,
  "kind"                VARCHAR(12) NOT NULL,
  "status"              VARCHAR(16) NOT NULL DEFAULT 'READY',
  "ruleKey"             VARCHAR(24),
  "label"               VARCHAR(300) NOT NULL,
  "basis"               VARCHAR(300),
  "hours"               DECIMAL(10,2) NOT NULL DEFAULT 0,
  "payAmount"           DECIMAL(12,2) NOT NULL DEFAULT 0,
  "amount"              DECIMAL(12,2) NOT NULL,
  "workFrom"            DATE,
  "workTo"              DATE,
  "associateId"         UUID,
  "payrollRunId"        UUID,
  "payrollItemId"       UUID,
  "sourceKey"           VARCHAR(160) NOT NULL,
  "originalStatementIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "billedStatementId"   UUID,
  "billedAt"            TIMESTAMPTZ(6),
  "approvalId"          UUID,
  "reason"              VARCHAR(500),
  "createdAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "BillingAdjustment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingAdjustment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BillingAdjustment_sourceKey_key" ON "BillingAdjustment"("sourceKey");
CREATE INDEX "BillingAdjustment_clientId_status_idx" ON "BillingAdjustment"("clientId", "status");
CREATE INDEX "BillingAdjustment_payrollRunId_idx" ON "BillingAdjustment"("payrollRunId");
CREATE INDEX "BillingAdjustment_tenantId_idx" ON "BillingAdjustment"("tenantId");
