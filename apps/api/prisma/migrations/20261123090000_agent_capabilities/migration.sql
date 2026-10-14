-- Agent families step 0 — capabilities, proposals and the tenant's kill switch
-- (docs/agent-families-investigation.md §8; owner's decisions 1, 2 and 5, 2026-10-13).
--
-- Additive: two enum values, one enum type, three tables, and the builtInKey
-- uniqueness made per tenant. The replaced index admits every row the old one
-- did (every built-in today is Alto HR's). The AgentControl singleton is not
-- touched: it stays the platform switch; converting it is 2-1 Migration C.
--
-- ALTER TYPE … ADD VALUE is allowed inside the migration's transaction on
-- Postgres 12+ because nothing below uses the new values.

-- 1. The two new gated actions.
ALTER TYPE "AgentGatedAction" ADD VALUE IF NOT EXISTS 'SHIFT_ASSIGN';
ALTER TYPE "AgentGatedAction" ADD VALUE IF NOT EXISTS 'CASE_OPEN';

-- 2. The proposal's states.
CREATE TYPE "AgentProposalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED', 'SUPERSEDED');

-- 3. The tables.
CREATE TABLE "AgentCapability" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "workerId"          UUID NOT NULL,
  "key"               VARCHAR(60) NOT NULL,
  "enabled"           BOOLEAN NOT NULL DEFAULT true,
  "suspendedAt"       TIMESTAMPTZ(6),
  "suspendedById"     UUID,
  "suspendReason"     VARCHAR(300),
  "driftErrorRatePct" INTEGER DEFAULT 25,
  "lastDriftAlertAt"  TIMESTAMPTZ(6),
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMPTZ(6) NOT NULL,
  "tenantId"          UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  CONSTRAINT "AgentCapability_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentCapability_workerId_key_key" ON "AgentCapability"("workerId", "key");
CREATE INDEX "AgentCapability_tenantId_idx" ON "AgentCapability"("tenantId");
ALTER TABLE "AgentCapability" ADD CONSTRAINT "AgentCapability_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "AgentProfile"("workerId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentProposal" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "workerId"      UUID NOT NULL,
  "capabilityKey" VARCHAR(60) NOT NULL,
  "subjectType"   VARCHAR(40) NOT NULL,
  "subjectId"     UUID,
  "payload"       JSONB NOT NULL,
  "approvalId"    UUID,
  "status"        "AgentProposalStatus" NOT NULL DEFAULT 'PROPOSED',
  "statusAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "outcome"       JSONB,
  "outcomeAt"     TIMESTAMPTZ(6),
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  CONSTRAINT "AgentProposal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentProposal_approvalId_key" ON "AgentProposal"("approvalId");
CREATE INDEX "AgentProposal_workerId_capabilityKey_createdAt_idx" ON "AgentProposal"("workerId", "capabilityKey", "createdAt" DESC);
CREATE INDEX "AgentProposal_subjectType_subjectId_idx" ON "AgentProposal"("subjectType", "subjectId");
CREATE INDEX "AgentProposal_tenantId_idx" ON "AgentProposal"("tenantId");
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "AgentProfile"("workerId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_approvalId_fkey"
  FOREIGN KEY ("approvalId") REFERENCES "AgentApprovalRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AgentTenantControl" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"       UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "allSuspendedAt" TIMESTAMPTZ(6),
  "suspendedById"  UUID,
  "reason"         VARCHAR(300),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgentTenantControl_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentTenantControl_tenantId_key" ON "AgentTenantControl"("tenantId");

-- 4. Built-ins are unique per tenant (owner's risk ruling 3: the partial
--    indexes ship in the same migration as the nullable key's new rule).
DROP INDEX IF EXISTS "AgentProfile_builtInKey_key";
CREATE UNIQUE INDEX "AgentProfile_tenant_builtInKey_key" ON "AgentProfile"("tenantId", "builtInKey") WHERE "builtInKey" IS NOT NULL;
CREATE UNIQUE INDEX "AgentProfile_notenant_builtInKey_key" ON "AgentProfile"("builtInKey") WHERE "tenantId" IS NULL AND "builtInKey" IS NOT NULL;

-- 5. One unsuspended switch per existing tenant. No enum literal in the SELECT.
INSERT INTO "AgentTenantControl" ("tenantId", "allSuspendedAt", "suspendedById", "reason", "updatedAt")
SELECT t."id", NULL, NULL, NULL, CURRENT_TIMESTAMP FROM "Tenant" t
ON CONFLICT ("tenantId") DO NOTHING;

-- 6. No AgentCapability rows here: the boot sweep creates them from the catalog
--    when the family agents arrive (step 1). The three existing agents get none.
