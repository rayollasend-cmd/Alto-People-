-- Brief 2-6 step 2 — customer-defined gates over the platform floor. Additive.

-- AlterEnum
ALTER TYPE "AgentGatedAction" ADD VALUE 'POLICY_GATE';

-- AlterTable
ALTER TABLE "AgentApprovalRequest" ADD COLUMN     "approverKind" VARCHAR(10),
ADD COLUMN     "approverRole" "Role",
ADD COLUMN     "approverUserId" UUID,
ADD COLUMN     "gatePolicyId" UUID;

-- CreateTable
CREATE TABLE "AgentGatePolicy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "scope" VARCHAR(12) NOT NULL,
    "scopeKey" VARCHAR(120),
    "action" VARCHAR(60) NOT NULL,
    "requirement" VARCHAR(14) NOT NULL,
    "approver" VARCHAR(10) NOT NULL DEFAULT 'OWNER',
    "approverRole" "Role",
    "approverUserId" UUID,
    "ttlHours" INTEGER NOT NULL DEFAULT 72,
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AgentGatePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentGatePolicy_tenantId_scope_idx" ON "AgentGatePolicy"("tenantId", "scope");

ALTER TABLE "AgentGatePolicy" ADD CONSTRAINT "AgentGatePolicy_scope_check" CHECK ("scope" IN ('TENANT', 'FAMILY', 'CAPABILITY', 'AGENT'));
ALTER TABLE "AgentGatePolicy" ADD CONSTRAINT "AgentGatePolicy_scope_key_check" CHECK (("scope" = 'TENANT') = ("scopeKey" IS NULL));
ALTER TABLE "AgentGatePolicy" ADD CONSTRAINT "AgentGatePolicy_requirement_check" CHECK ("requirement" IN ('REQUIRED', 'NOT_REQUIRED'));
ALTER TABLE "AgentGatePolicy" ADD CONSTRAINT "AgentGatePolicy_approver_check" CHECK ("approver" IN ('OWNER', 'ROLE', 'DESK', 'USER'));
-- ROLE names its role, USER its person; nothing else names either.
ALTER TABLE "AgentGatePolicy" ADD CONSTRAINT "AgentGatePolicy_approver_role_check" CHECK (("approver" = 'ROLE') = ("approverRole" IS NOT NULL));
ALTER TABLE "AgentGatePolicy" ADD CONSTRAINT "AgentGatePolicy_approver_user_check" CHECK (("approver" = 'USER') = ("approverUserId" IS NOT NULL));
ALTER TABLE "AgentGatePolicy" ADD CONSTRAINT "AgentGatePolicy_ttl_check" CHECK ("ttlHours" BETWEEN 1 AND 168);
