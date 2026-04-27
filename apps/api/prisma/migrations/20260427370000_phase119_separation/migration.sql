-- Phase 119 — Separations + exit interviews. The "leave" side of the
-- onboarding/lifecycle. One in-flight separation per associate at a time —
-- enforced by partial unique index on associateId WHERE status != 'COMPLETE'.
-- Historical separations are kept (an associate can be re-hired and
-- re-separated; both rows live forever).
CREATE TYPE "SeparationReason" AS ENUM (
  'VOLUNTARY_OTHER_OPPORTUNITY',
  'VOLUNTARY_PERSONAL',
  'VOLUNTARY_RELOCATION',
  'VOLUNTARY_RETIREMENT',
  'INVOLUNTARY_PERFORMANCE',
  'INVOLUNTARY_LAYOFF',
  'INVOLUNTARY_MISCONDUCT',
  'END_OF_CONTRACT',
  'DECEASED',
  'OTHER'
);

CREATE TYPE "SeparationStatus" AS ENUM (
  'PLANNED',
  'IN_PROGRESS',
  'COMPLETE'
);

CREATE TABLE "Separation" (
  "id"                     UUID                NOT NULL DEFAULT gen_random_uuid(),
  "associateId"            UUID                NOT NULL,
  "reason"                 "SeparationReason"  NOT NULL,
  "status"                 "SeparationStatus"  NOT NULL DEFAULT 'PLANNED',
  "noticeDate"             DATE,
  "lastDayWorked"          DATE                NOT NULL,
  "finalPaycheckDate"      DATE,
  "rating"                 INTEGER,
  "reasonNotes"            TEXT,
  "feedbackPositive"       TEXT,
  "feedbackImprovement"    TEXT,
  "wouldRecommend"         BOOLEAN,
  "wouldReturn"            BOOLEAN,
  "exitInterviewCompletedAt" TIMESTAMPTZ(6),
  "exitInterviewByUserId"  UUID,
  "initiatedById"          UUID,
  "completedById"          UUID,
  "completedAt"            TIMESTAMPTZ(6),
  "createdAt"              TIMESTAMPTZ(6)      NOT NULL DEFAULT NOW(),
  "updatedAt"              TIMESTAMPTZ(6)      NOT NULL,
  CONSTRAINT "Separation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Separation_associateId_idx" ON "Separation"("associateId");
CREATE INDEX "Separation_status_idx" ON "Separation"("status");
CREATE INDEX "Separation_lastDayWorked_idx" ON "Separation"("lastDayWorked");
CREATE UNIQUE INDEX "Separation_active_per_associate_idx"
  ON "Separation"("associateId")
  WHERE "status" != 'COMPLETE';

ALTER TABLE "Separation" ADD CONSTRAINT "Separation_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Separation" ADD CONSTRAINT "Separation_initiatedById_fkey"
  FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Separation" ADD CONSTRAINT "Separation_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Separation" ADD CONSTRAINT "Separation_exitInterviewByUserId_fkey"
  FOREIGN KEY ("exitInterviewByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
