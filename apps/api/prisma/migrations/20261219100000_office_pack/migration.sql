-- The office pack (2026-10-17): the candidate's own page, the recruiter's
-- calendar feed, marketing's careers analytics / employer brand / referral
-- campaigns, and the quarterly client NPS the executive reads.

-- ----- Candidate portal ------------------------------------------------------
ALTER TABLE "Candidate"
  ADD COLUMN "portalTokenHash" VARCHAR(64),
  ADD COLUMN "portalTokenExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "portalLastSeenAt" TIMESTAMPTZ(6);
CREATE UNIQUE INDEX "Candidate_portalTokenHash_key" ON "Candidate"("portalTokenHash");

ALTER TABLE "Interview" ADD COLUMN "candidateConfirmedAt" TIMESTAMPTZ(6);

ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'PORTAL_LINK_SENT';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'INTERVIEW_CONFIRMED';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'DOCUMENT_REQUESTED';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'DOCUMENT_UPLOADED';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'DOCUMENT_REVIEWED';

CREATE TABLE "CandidateDocumentRequest" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "candidateId"   UUID NOT NULL REFERENCES "Candidate"("id") ON DELETE CASCADE,
  "label"         VARCHAR(120) NOT NULL,
  "note"          VARCHAR(500),
  "status"        VARCHAR(16) NOT NULL DEFAULT 'REQUESTED',
  "s3Key"         VARCHAR(400),
  "fileName"      VARCHAR(255),
  "contentType"   VARCHAR(120),
  "sizeBytes"     INTEGER,
  "uploadedAt"    TIMESTAMPTZ(6),
  "reviewNote"    VARCHAR(500),
  "reviewedAt"    TIMESTAMPTZ(6),
  "reviewedById"  UUID REFERENCES "User"("id") ON DELETE SET NULL,
  "requestedById" UUID REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX "CandidateDocumentRequest_candidateId_status_idx" ON "CandidateDocumentRequest"("candidateId", "status");
CREATE INDEX "CandidateDocumentRequest_tenantId_idx" ON "CandidateDocumentRequest"("tenantId");

-- ----- The recruiter's calendar feed ----------------------------------------
CREATE TABLE "UserCalendarFeed" (
  "userId"    UUID PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
  "tenantId"  UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "version"   INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX "UserCalendarFeed_tenantId_idx" ON "UserCalendarFeed"("tenantId");

-- ----- Marketing ------------------------------------------------------------
CREATE TABLE "CareersPageView" (
  "id"       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "slug"     VARCHAR(200) NOT NULL DEFAULT '',
  "source"   VARCHAR(120) NOT NULL DEFAULT '',
  "day"      DATE NOT NULL,
  "count"    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "CareersPageView_slug_source_day_key" ON "CareersPageView"("slug", "source", "day");
CREATE INDEX "CareersPageView_day_idx" ON "CareersPageView"("day");
CREATE INDEX "CareersPageView_tenantId_idx" ON "CareersPageView"("tenantId");

CREATE TABLE "EmployerBrand" (
  "id"          VARCHAR(16) PRIMARY KEY DEFAULT 'singleton',
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "headline"    VARCHAR(160),
  "intro"       VARCHAR(2000),
  "values"      JSONB NOT NULL DEFAULT '[]',
  "perks"       JSONB NOT NULL DEFAULT '[]',
  "ctaText"     VARCHAR(80),
  "updatedById" UUID,
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL
);
CREATE UNIQUE INDEX "EmployerBrand_tenantId_key" ON "EmployerBrand"("tenantId");

CREATE TABLE "EmployerBrandPhoto" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "brandId"     VARCHAR(16) NOT NULL REFERENCES "EmployerBrand"("id") ON DELETE CASCADE,
  "s3Key"       VARCHAR(400) NOT NULL,
  "contentType" VARCHAR(120) NOT NULL,
  "alt"         VARCHAR(200) NOT NULL,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "EmployerBrandPhoto_brandId_sortOrder_idx" ON "EmployerBrandPhoto"("brandId", "sortOrder");
CREATE INDEX "EmployerBrandPhoto_tenantId_idx" ON "EmployerBrandPhoto"("tenantId");

CREATE TABLE "ReferralCampaign" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"     UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "name"         VARCHAR(120) NOT NULL,
  "description"  VARCHAR(1000),
  "bonusAmount"  DECIMAL(10,2) NOT NULL,
  "currency"     VARCHAR(3) NOT NULL DEFAULT 'USD',
  "payAfterDays" INTEGER NOT NULL DEFAULT 30,
  "startsOn"     DATE NOT NULL,
  "endsOn"       DATE,
  "positions"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"       VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  "createdById"  UUID REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX "ReferralCampaign_status_startsOn_idx" ON "ReferralCampaign"("status", "startsOn");
CREATE INDEX "ReferralCampaign_tenantId_idx" ON "ReferralCampaign"("tenantId");

ALTER TABLE "Referral" ADD COLUMN "campaignId" UUID REFERENCES "ReferralCampaign"("id") ON DELETE SET NULL;

CREATE TABLE "ReferralBonusPayout" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"          UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "referralId"        UUID NOT NULL UNIQUE REFERENCES "Referral"("id") ON DELETE CASCADE,
  "campaignId"        UUID REFERENCES "ReferralCampaign"("id") ON DELETE SET NULL,
  "associateId"       UUID NOT NULL REFERENCES "Associate"("id") ON DELETE CASCADE,
  "amount"            DECIMAL(10,2) NOT NULL,
  "currency"          VARCHAR(3) NOT NULL DEFAULT 'USD',
  "status"            VARCHAR(12) NOT NULL DEFAULT 'PROPOSED',
  "note"              VARCHAR(500),
  "proposedById"      UUID REFERENCES "User"("id") ON DELETE SET NULL,
  "decidedById"       UUID REFERENCES "User"("id") ON DELETE SET NULL,
  "decidedAt"         TIMESTAMPTZ(6),
  "decisionNote"      VARCHAR(500),
  "payrollRunId"      UUID,
  "payrollRunAddOnId" UUID,
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX "ReferralBonusPayout_status_createdAt_idx" ON "ReferralBonusPayout"("status", "createdAt");
CREATE INDEX "ReferralBonusPayout_tenantId_idx" ON "ReferralBonusPayout"("tenantId");

-- ----- Client NPS -----------------------------------------------------------
CREATE TABLE "ClientNpsWave" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"  UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "quarter"   VARCHAR(7) NOT NULL,
  "sentAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "closesAt"  TIMESTAMPTZ(6) NOT NULL,
  "sentById"  UUID REFERENCES "User"("id") ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ClientNpsWave_tenantId_quarter_key" ON "ClientNpsWave"("tenantId", "quarter");
CREATE INDEX "ClientNpsWave_sentAt_idx" ON "ClientNpsWave"("sentAt");

CREATE TABLE "ClientNpsInvite" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "waveId"      UUID NOT NULL REFERENCES "ClientNpsWave"("id") ON DELETE CASCADE,
  "clientId"    UUID NOT NULL REFERENCES "Client"("id") ON DELETE CASCADE,
  "userId"      UUID REFERENCES "User"("id") ON DELETE SET NULL,
  "email"       VARCHAR(254) NOT NULL,
  "tokenHash"   VARCHAR(64) NOT NULL UNIQUE,
  "expiresAt"   TIMESTAMPTZ(6) NOT NULL,
  "remindedAt"  TIMESTAMPTZ(6),
  "respondedAt" TIMESTAMPTZ(6),
  "score"       INTEGER,
  "comment"     VARCHAR(2000),
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "ClientNpsInvite_waveId_clientId_idx" ON "ClientNpsInvite"("waveId", "clientId");
CREATE INDEX "ClientNpsInvite_clientId_respondedAt_idx" ON "ClientNpsInvite"("clientId", "respondedAt");
CREATE INDEX "ClientNpsInvite_tenantId_idx" ON "ClientNpsInvite"("tenantId");
