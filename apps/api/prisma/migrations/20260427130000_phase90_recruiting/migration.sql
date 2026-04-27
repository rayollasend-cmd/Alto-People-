-- Phase 90 — Interview kits, offer letters, referrals, careers page.

CREATE TYPE "OfferStatus" AS ENUM (
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'WITHDRAWN'
);

CREATE TYPE "ReferralStatus" AS ENUM (
  'OPEN',
  'INTERVIEWING',
  'HIRED',
  'REJECTED'
);

CREATE TYPE "JobPostingStatus" AS ENUM (
  'DRAFT',
  'OPEN',
  'CLOSED'
);

CREATE TABLE "InterviewKit" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  -- Array of question objects: [{prompt, kind, hint}]. Schema is
  -- enforced by the API rather than DB.
  "questions"   JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "InterviewKit_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "InterviewKit_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "InterviewKit_clientId_idx" ON "InterviewKit" ("clientId");

CREATE TABLE "Interview" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "candidateId"      UUID NOT NULL,
  "kitId"            UUID,
  "interviewerUserId" UUID,
  "scheduledFor"     TIMESTAMPTZ(6) NOT NULL,
  "completedAt"      TIMESTAMPTZ(6),
  -- Free-form notes / scorecard JSON.
  "scorecard"        JSONB,
  -- Aggregate decision: STRONG_NO=-2, NO=-1, MAYBE=0, YES=1, STRONG_YES=2.
  "rating"           INTEGER,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Interview_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE,
  CONSTRAINT "Interview_kitId_fkey"
    FOREIGN KEY ("kitId") REFERENCES "InterviewKit"("id") ON DELETE SET NULL,
  CONSTRAINT "Interview_interviewerUserId_fkey"
    FOREIGN KEY ("interviewerUserId") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "Interview_rating_check"
    CHECK ("rating" IS NULL OR "rating" BETWEEN -2 AND 2)
);
CREATE INDEX "Interview_candidateId_idx" ON "Interview" ("candidateId");
CREATE INDEX "Interview_interviewerUserId_idx" ON "Interview" ("interviewerUserId");

CREATE TABLE "Offer" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "candidateId"  UUID NOT NULL,
  "clientId"     UUID NOT NULL,
  "jobTitle"     TEXT NOT NULL,
  "startDate"    DATE NOT NULL,
  "salary"       DECIMAL(12, 2),
  "hourlyRate"   DECIMAL(8, 2),
  "currency"     VARCHAR(3) NOT NULL DEFAULT 'USD',
  -- Rendered offer letter body (mail-merge output).
  "letterBody"   TEXT,
  "templateRenderId" UUID,
  "status"       "OfferStatus" NOT NULL DEFAULT 'DRAFT',
  "sentAt"       TIMESTAMPTZ(6),
  "decidedAt"    TIMESTAMPTZ(6),
  "expiresAt"    TIMESTAMPTZ(6),
  "createdById"  UUID,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Offer_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE,
  CONSTRAINT "Offer_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "Offer_templateRenderId_fkey"
    FOREIGN KEY ("templateRenderId") REFERENCES "DocumentRender"("id") ON DELETE SET NULL,
  CONSTRAINT "Offer_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "Offer_pay_check"
    CHECK ("salary" IS NOT NULL OR "hourlyRate" IS NOT NULL)
);
CREATE INDEX "Offer_candidateId_idx" ON "Offer" ("candidateId");
CREATE INDEX "Offer_status_idx" ON "Offer" ("status");

CREATE TABLE "Referral" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "referrerUserId" UUID NOT NULL,
  -- Optional candidate created from this referral (post-application).
  "candidateId"    UUID,
  "candidateName"  TEXT NOT NULL,
  "candidateEmail" TEXT NOT NULL,
  "candidatePhone" TEXT,
  "position"       TEXT,
  "notes"          TEXT,
  "status"         "ReferralStatus" NOT NULL DEFAULT 'OPEN',
  -- Bonus payable on hire (HR sets per program).
  "bonusAmount"    DECIMAL(10, 2),
  "bonusCurrency"  VARCHAR(3) NOT NULL DEFAULT 'USD',
  "bonusPaidAt"    TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Referral_referrerUserId_fkey"
    FOREIGN KEY ("referrerUserId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "Referral_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL
);
CREATE INDEX "Referral_referrerUserId_idx" ON "Referral" ("referrerUserId");
CREATE INDEX "Referral_status_idx" ON "Referral" ("status");

CREATE TABLE "JobPosting" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"     UUID,
  "title"        TEXT NOT NULL,
  "description"  TEXT NOT NULL,
  "location"     TEXT,
  "minSalary"    DECIMAL(12, 2),
  "maxSalary"    DECIMAL(12, 2),
  "currency"     VARCHAR(3) NOT NULL DEFAULT 'USD',
  -- Public-facing slug for the careers page URL.
  "slug"         TEXT NOT NULL UNIQUE,
  "status"       "JobPostingStatus" NOT NULL DEFAULT 'DRAFT',
  "openedAt"     TIMESTAMPTZ(6),
  "closedAt"     TIMESTAMPTZ(6),
  "createdById"  UUID,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "JobPosting_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "JobPosting_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "JobPosting_status_idx" ON "JobPosting" ("status");
CREATE INDEX "JobPosting_clientId_idx" ON "JobPosting" ("clientId");
