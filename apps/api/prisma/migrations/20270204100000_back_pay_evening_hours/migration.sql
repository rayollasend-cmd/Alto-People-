-- Deep audit 2026-10-29 (builder PAY), the owner's answer: pay the evening
-- hours the old UTC pay-period cut never paid (lib/payrollBackPay).
--
-- Additive only. Two enum values (an earning code and an approval kind) and
-- one new, empty table — one row per punch put on a run as back pay, unique
-- per punch so it can never be paid twice. No existing row changes.

ALTER TYPE "PayrollEarningKind" ADD VALUE IF NOT EXISTS 'BACK_PAY';
ALTER TYPE "ApprovalRequestKind" ADD VALUE IF NOT EXISTS 'BACK_PAY';

CREATE TABLE IF NOT EXISTS "BackPayClaim" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "timeEntryId" UUID NOT NULL,
  "associateId" UUID NOT NULL,
  "sourceRunId" UUID,
  "payrollRunId" UUID,
  "addOnId" UUID,
  "approvalRequestId" UUID,
  "workDate" DATE NOT NULL,
  "hours" DECIMAL(8,2) NOT NULL,
  "rate" DECIMAL(8,2) NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'ADDED',
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BackPayClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BackPayClaim_tenantId_timeEntryId_key" ON "BackPayClaim"("tenantId", "timeEntryId");
CREATE INDEX IF NOT EXISTS "BackPayClaim_tenantId_idx" ON "BackPayClaim"("tenantId");
CREATE INDEX IF NOT EXISTS "BackPayClaim_associateId_idx" ON "BackPayClaim"("associateId");
CREATE INDEX IF NOT EXISTS "BackPayClaim_payrollRunId_idx" ON "BackPayClaim"("payrollRunId");

SELECT alto_tenant_rls_policies('BackPayClaim');
ALTER TABLE "BackPayClaim" ENABLE ROW LEVEL SECURITY;
