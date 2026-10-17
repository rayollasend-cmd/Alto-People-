-- Approval engine (2026-10): one record for every change that needs a second
-- person, the workflow engine's queue bookkeeping and its REQUIRE_APPROVAL
-- action, temporary elevated access, approval delegation, promotions and the
-- tasks a workflow hands a person. Hand-written; nothing here resets data.

ALTER TYPE "WorkflowActionKind" ADD VALUE IF NOT EXISTS 'REQUIRE_APPROVAL';
ALTER TYPE "WorkflowRunStatus" ADD VALUE IF NOT EXISTS 'WAITING';
ALTER TYPE "WorkflowStepStatus" ADD VALUE IF NOT EXISTS 'WAITING';

ALTER TABLE "WorkflowStep"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMPTZ(6);

CREATE TYPE "ApprovalRequestKind" AS ENUM ('PAY_RATE_CHANGE', 'BILL_RATE_CHANGE', 'SEPARATION_COMPLETE', 'SELF_SERVICE_CHANGE', 'PROMOTION', 'REQUISITION', 'ROLE_CHANGE', 'WORKFLOW_GATE');
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "PromotionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED');
CREATE TYPE "WorkflowTaskStatus" AS ENUM ('OPEN', 'DONE');

CREATE TABLE "ApprovalRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "kind" "ApprovalRequestKind" NOT NULL,
  "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
  "subjectType" VARCHAR(60) NOT NULL,
  "subjectId" UUID NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "summary" VARCHAR(2000),
  "proposed" JSONB NOT NULL,
  "before" JSONB,
  "requesterUserId" UUID,
  "approverCapability" VARCHAR(60),
  "approverUserId" UUID,
  "approverRole" "Role",
  "clientId" UUID,
  "associateId" UUID,
  "workflowRunId" UUID,
  "workflowStepId" UUID,
  "decidedById" UUID,
  "decidedAt" TIMESTAMPTZ(6),
  "reason" VARCHAR(2000),
  "appliedAt" TIMESTAMPTZ(6),
  "applyError" VARCHAR(2000),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApprovalRequest_tenantId_status_createdAt_idx" ON "ApprovalRequest"("tenantId", "status", "createdAt" DESC);
CREATE INDEX "ApprovalRequest_subjectType_subjectId_idx" ON "ApprovalRequest"("subjectType", "subjectId");
CREATE INDEX "ApprovalRequest_requesterUserId_status_idx" ON "ApprovalRequest"("requesterUserId", "status");
CREATE INDEX "ApprovalRequest_associateId_idx" ON "ApprovalRequest"("associateId");

CREATE TABLE "ApprovalDelegation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "fromUserId" UUID NOT NULL,
  "toUserId" UUID NOT NULL,
  "startsOn" DATE NOT NULL,
  "endsOn" DATE NOT NULL,
  "note" VARCHAR(200),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApprovalDelegation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApprovalDelegation_toUserId_endsOn_idx" ON "ApprovalDelegation"("toUserId", "endsOn");
CREATE INDEX "ApprovalDelegation_fromUserId_endsOn_idx" ON "ApprovalDelegation"("fromUserId", "endsOn");
CREATE INDEX "ApprovalDelegation_tenantId_idx" ON "ApprovalDelegation"("tenantId");

CREATE TABLE "AccessGrant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "role" "Role" NOT NULL,
  "grantedById" UUID,
  "reason" VARCHAR(300) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revertedAt" TIMESTAMPTZ(6),
  "revertedById" UUID,
  "revertedWhy" VARCHAR(120),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccessGrant_userId_revertedAt_idx" ON "AccessGrant"("userId", "revertedAt");
CREATE INDEX "AccessGrant_tenantId_revertedAt_expiresAt_idx" ON "AccessGrant"("tenantId", "revertedAt", "expiresAt");

CREATE TABLE "Promotion" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "jobProfileId" UUID,
  "newTitle" VARCHAR(120),
  "level" VARCHAR(40),
  "payType" "PayType",
  "amount" DECIMAL(12,2),
  "effectiveFrom" DATE NOT NULL,
  "notes" VARCHAR(2000),
  "status" "PromotionStatus" NOT NULL DEFAULT 'PENDING',
  "approvalRequestId" UUID,
  "requestedById" UUID,
  "letterDocumentId" UUID,
  "appliedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Promotion_associateId_createdAt_idx" ON "Promotion"("associateId", "createdAt" DESC);
CREATE INDEX "Promotion_tenantId_status_idx" ON "Promotion"("tenantId", "status");

CREATE TABLE "WorkflowTask" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "runId" UUID,
  "title" VARCHAR(200) NOT NULL,
  "details" VARCHAR(2000),
  "assigneeUserId" UUID,
  "assigneeRole" "Role",
  "entityType" VARCHAR(60),
  "entityId" UUID,
  "linkUrl" VARCHAR(300),
  "dueAt" TIMESTAMPTZ(6),
  "status" "WorkflowTaskStatus" NOT NULL DEFAULT 'OPEN',
  "doneById" UUID,
  "doneAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkflowTask_tenantId_status_assigneeUserId_idx" ON "WorkflowTask"("tenantId", "status", "assigneeUserId");
CREATE INDEX "WorkflowTask_tenantId_status_assigneeRole_idx" ON "WorkflowTask"("tenantId", "status", "assigneeRole");
CREATE INDEX "WorkflowTask_runId_idx" ON "WorkflowTask"("runId");

ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "requisitionApprovalId" UUID;

ALTER TABLE "OrgSetting"
  ADD COLUMN IF NOT EXISTS "payChangeApprovalPct" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "payChangeAlwaysApprove" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "billRateApproval" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "separationSecondPerson" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "selfServiceApproval" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "roleChangeApproval" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "requisitionApproval" BOOLEAN NOT NULL DEFAULT true;
