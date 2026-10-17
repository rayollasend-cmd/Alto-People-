-- HR pack (2026-10): case SLAs, policy campaigns, verification letters,
-- document retention, mass update, position budgets, separation asset return.

-- HR case SLA clock
ALTER TABLE "HrCase" ADD COLUMN "dueAt" TIMESTAMPTZ(6);
ALTER TABLE "HrCase" ADD COLUMN "slaPausedAt" TIMESTAMPTZ(6);
ALTER TABLE "HrCase" ADD COLUMN "slaPausedMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "HrCase" ADD COLUMN "slaBreachedAt" TIMESTAMPTZ(6);
ALTER TABLE "HrCase" ADD COLUMN "slaEscalatedAt" TIMESTAMPTZ(6);
CREATE INDEX "HrCase_dueAt_idx" ON "HrCase"("dueAt");

CREATE TABLE "HrCaseSlaPolicy" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "category" "CaseCategory" NOT NULL,
  "priority" "CasePriority" NOT NULL,
  "targetHours" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "HrCaseSlaPolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HrCaseSlaPolicy_tenantId_category_priority_key" ON "HrCaseSlaPolicy"("tenantId", "category", "priority");

-- Policy campaigns
CREATE TYPE "PolicyCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');
CREATE TYPE "PolicyCampaignRecipientStatus" AS ENUM ('PENDING', 'SIGNED', 'WAIVED');

CREATE TABLE "PolicyCampaign" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "name" TEXT NOT NULL,
  "templateId" UUID NOT NULL,
  "versionId" UUID NOT NULL,
  "audience" JSONB NOT NULL,
  "dueOn" DATE NOT NULL,
  "reminderEveryDays" INTEGER NOT NULL DEFAULT 3,
  "status" "PolicyCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "createdById" UUID,
  "launchedAt" TIMESTAMPTZ(6),
  "closedAt" TIMESTAMPTZ(6),
  "lastReminderAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PolicyCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PolicyCampaign_tenantId_status_idx" ON "PolicyCampaign"("tenantId", "status");
ALTER TABLE "PolicyCampaign" ADD CONSTRAINT "PolicyCampaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DocumentTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PolicyCampaign" ADD CONSTRAINT "PolicyCampaign_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PolicyCampaignRecipient" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "campaignId" UUID NOT NULL,
  "associateId" UUID NOT NULL,
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "status" "PolicyCampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
  "renderedBody" TEXT NOT NULL,
  "signature" TEXT,
  "signedAt" TIMESTAMPTZ(6),
  "signerIp" TEXT,
  "signerUserAgent" TEXT,
  "contentSha256" TEXT,
  "remindedAt" TIMESTAMPTZ(6),
  "waivedById" UUID,
  "waiveReason" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PolicyCampaignRecipient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PolicyCampaignRecipient_campaignId_associateId_key" ON "PolicyCampaignRecipient"("campaignId", "associateId");
CREATE INDEX "PolicyCampaignRecipient_associateId_status_idx" ON "PolicyCampaignRecipient"("associateId", "status");
CREATE INDEX "PolicyCampaignRecipient_tenantId_idx" ON "PolicyCampaignRecipient"("tenantId");
ALTER TABLE "PolicyCampaignRecipient" ADD CONSTRAINT "PolicyCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "PolicyCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PolicyCampaignRecipient" ADD CONSTRAINT "PolicyCampaignRecipient_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Verification letters
CREATE TYPE "VerificationLetterKind" AS ENUM ('EMPLOYMENT', 'INCOME');
CREATE TYPE "VerificationLetterStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DECLINED');

CREATE TABLE "VerificationLetter" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "kind" "VerificationLetterKind" NOT NULL,
  "status" "VerificationLetterStatus" NOT NULL DEFAULT 'REQUESTED',
  "addressedTo" TEXT,
  "purpose" TEXT,
  "requestedByUserId" UUID,
  "decidedById" UUID,
  "decidedAt" TIMESTAMPTZ(6),
  "declineReason" TEXT,
  "snapshot" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "VerificationLetter_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VerificationLetter_associateId_idx" ON "VerificationLetter"("associateId");
CREATE INDEX "VerificationLetter_tenantId_status_idx" ON "VerificationLetter"("tenantId", "status");
ALTER TABLE "VerificationLetter" ADD CONSTRAINT "VerificationLetter_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Document retention
CREATE TABLE "DocumentRetentionPolicy" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "kind" "DocumentKind" NOT NULL,
  "retainYearsAfterSeparation" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "DocumentRetentionPolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DocumentRetentionPolicy_tenantId_kind_key" ON "DocumentRetentionPolicy"("tenantId", "kind");
ALTER TABLE "DocumentRecord" ADD COLUMN "purgedAt" TIMESTAMPTZ(6);

-- Mass update
CREATE TABLE "MassUpdateBatch" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "actorUserId" UUID,
  "filter" JSONB NOT NULL,
  "changes" JSONB NOT NULL,
  "affected" JSONB NOT NULL,
  "affectedCount" INTEGER NOT NULL,
  "appliedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMPTZ(6),
  "undoneById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MassUpdateBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MassUpdateBatch_tenantId_appliedAt_idx" ON "MassUpdateBatch"("tenantId", "appliedAt" DESC);

-- Position budgets
ALTER TABLE "Position" ADD COLUMN "budgetAmount" DECIMAL(12,2);
ALTER TABLE "Position" ADD COLUMN "budgetPeriod" VARCHAR(16);

-- Separation: asset return and final pay
ALTER TABLE "Separation" ADD COLUMN "assetsWaivedAt" TIMESTAMPTZ(6);
ALTER TABLE "Separation" ADD COLUMN "assetsWaivedById" UUID;
ALTER TABLE "Separation" ADD COLUMN "assetsWaiveReason" TEXT;
ALTER TABLE "Separation" ADD COLUMN "finalPaySnapshot" JSONB;
