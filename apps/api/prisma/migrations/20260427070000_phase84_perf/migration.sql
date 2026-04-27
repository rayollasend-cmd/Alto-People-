-- Phase 84 — Performance: Goals/OKRs, 1:1s, Kudos, PIPs, 360 reviews.
--
-- Five additive tables. Each is keyed by associateId; multi-tenant scoping
-- runs through Associate's existing relationship to Client. PerformanceReview
-- already exists from Phase 47 for annual reviews — these are the lighter-
-- weight surfaces that wrap the year.

CREATE TYPE "GoalStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'AT_RISK',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE "GoalKind" AS ENUM ('GOAL', 'OBJECTIVE');

CREATE TYPE "OneOnOneStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED');

CREATE TYPE "PipStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'PASSED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "Review360Status" AS ENUM (
  'COLLECTING',
  'COMPLETED',
  'CANCELLED'
);

-- Goals + OKRs: Goal == personal goal (no key results); Objective == OKR
-- with key results. Same table to keep filtering simple; key_result rows
-- are only created when kind = OBJECTIVE.
CREATE TABLE "Goal" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"   UUID NOT NULL,
  "kind"          "GoalKind" NOT NULL DEFAULT 'GOAL',
  "title"         TEXT NOT NULL,
  "description"   TEXT,
  -- Optional parent for cascading goals (manager goal → IC goal).
  "parentGoalId"  UUID,
  "periodStart"   DATE NOT NULL,
  "periodEnd"     DATE NOT NULL,
  "status"        "GoalStatus" NOT NULL DEFAULT 'DRAFT',
  -- 0–100; manually updated or rolled up from key results when kind=OBJECTIVE.
  "progressPct"   INTEGER NOT NULL DEFAULT 0,
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"     TIMESTAMPTZ(6),
  CONSTRAINT "Goal_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "Goal_parentGoalId_fkey"
    FOREIGN KEY ("parentGoalId") REFERENCES "Goal"("id") ON DELETE SET NULL,
  CONSTRAINT "Goal_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "Goal_progress_check" CHECK ("progressPct" BETWEEN 0 AND 100),
  CONSTRAINT "Goal_period_check" CHECK ("periodEnd" >= "periodStart")
);
CREATE INDEX "Goal_associateId_status_idx" ON "Goal" ("associateId", "status");
CREATE INDEX "Goal_parentGoalId_idx" ON "Goal" ("parentGoalId");

CREATE TABLE "KeyResult" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "goalId"        UUID NOT NULL,
  "title"         TEXT NOT NULL,
  -- Free-form numeric metric for measurable KRs (revenue, NPS, etc.).
  "targetValue"   DECIMAL(14, 2),
  "currentValue"  DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "unit"          TEXT,
  "progressPct"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "KeyResult_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE,
  CONSTRAINT "KeyResult_progress_check"
    CHECK ("progressPct" BETWEEN 0 AND 100)
);
CREATE INDEX "KeyResult_goalId_idx" ON "KeyResult" ("goalId");

-- One-on-ones: a recurring meeting between an associate and their manager.
-- Each row is a scheduled instance with shared talking points + private notes.
CREATE TABLE "OneOnOne" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"    UUID NOT NULL,
  "managerUserId"  UUID NOT NULL,
  "scheduledFor"   TIMESTAMPTZ(6) NOT NULL,
  "completedAt"    TIMESTAMPTZ(6),
  -- Talking points are shared with both parties.
  "agenda"         TEXT,
  -- Manager-only notes (not surfaced to the associate).
  "managerNotes"   TEXT,
  -- Associate-side prep that becomes shared after they submit.
  "associateNotes" TEXT,
  "status"         "OneOnOneStatus" NOT NULL DEFAULT 'SCHEDULED',
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "OneOnOne_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "OneOnOne_managerUserId_fkey"
    FOREIGN KEY ("managerUserId") REFERENCES "User"("id") ON DELETE CASCADE
);
CREATE INDEX "OneOnOne_associateId_scheduled_idx"
  ON "OneOnOne" ("associateId", "scheduledFor" DESC);
CREATE INDEX "OneOnOne_managerUserId_idx"
  ON "OneOnOne" ("managerUserId", "scheduledFor" DESC);

-- Kudos: peer-to-peer appreciation. fromUserId is the giver; toAssociateId
-- is the recipient. isPublic surfaces it on a company feed; private kudos
-- stay between giver/recipient + manager.
CREATE TABLE "Kudo" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "fromUserId"     UUID NOT NULL,
  "toAssociateId"  UUID NOT NULL,
  "message"        TEXT NOT NULL,
  -- Optional tags (e.g., company values: "ownership", "craft").
  "tags"           TEXT[] NOT NULL DEFAULT '{}',
  "isPublic"       BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "Kudo_fromUserId_fkey"
    FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "Kudo_toAssociateId_fkey"
    FOREIGN KEY ("toAssociateId") REFERENCES "Associate"("id") ON DELETE CASCADE
);
CREATE INDEX "Kudo_toAssociateId_idx" ON "Kudo" ("toAssociateId", "createdAt" DESC);
CREATE INDEX "Kudo_isPublic_createdAt_idx" ON "Kudo" ("isPublic", "createdAt" DESC);

-- Performance Improvement Plan: structured remediation. The associate has
-- N weeks to hit the listed expectations; outcome is PASSED / FAILED.
CREATE TABLE "Pip" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"    UUID NOT NULL,
  "managerUserId"  UUID,
  "startDate"      DATE NOT NULL,
  "endDate"        DATE NOT NULL,
  "reason"         TEXT NOT NULL,
  "expectations"   TEXT NOT NULL,
  "supportPlan"    TEXT,
  "status"         "PipStatus" NOT NULL DEFAULT 'DRAFT',
  "outcomeNote"    TEXT,
  "decidedAt"      TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Pip_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "Pip_managerUserId_fkey"
    FOREIGN KEY ("managerUserId") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "Pip_period_check" CHECK ("endDate" >= "startDate")
);
CREATE INDEX "Pip_associateId_status_idx" ON "Pip" ("associateId", "status");

-- 360 reviews: many feedback givers per subject. Anonymous == feedback is
-- visible only in aggregate to managers/HR (raw rows still keyed for audit).
CREATE TABLE "Review360" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "subjectAssociateId" UUID NOT NULL,
  "requestedById"    UUID,
  "periodStart"      DATE NOT NULL,
  "periodEnd"        DATE NOT NULL,
  "status"           "Review360Status" NOT NULL DEFAULT 'COLLECTING',
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Review360_subject_fkey"
    FOREIGN KEY ("subjectAssociateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "Review360_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "Review360_subject_status_idx"
  ON "Review360" ("subjectAssociateId", "status");

CREATE TABLE "Review360Feedback" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reviewId"          UUID NOT NULL,
  -- Who's giving feedback. May be null when fully anonymous.
  "fromUserId"        UUID,
  "isAnonymous"       BOOLEAN NOT NULL DEFAULT FALSE,
  "strengths"         TEXT,
  "improvements"      TEXT,
  -- 1–5 numeric rating; null if reviewer skipped it.
  "rating"            INTEGER,
  "submittedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "Review360Feedback_reviewId_fkey"
    FOREIGN KEY ("reviewId") REFERENCES "Review360"("id") ON DELETE CASCADE,
  CONSTRAINT "Review360Feedback_fromUserId_fkey"
    FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "Review360Feedback_rating_check"
    CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
);
CREATE INDEX "Review360Feedback_reviewId_idx"
  ON "Review360Feedback" ("reviewId");
