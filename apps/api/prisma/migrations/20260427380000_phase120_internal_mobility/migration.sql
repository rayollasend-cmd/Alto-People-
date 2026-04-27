-- Phase 120 — Internal mobility. Lets current associates apply to internal
-- JobPostings. Unique on (postingId, associateId) blocks double-apply; an
-- associate must withdraw their application before re-applying.
CREATE TYPE "InternalApplicationStatus" AS ENUM (
  'SUBMITTED',
  'UNDER_REVIEW',
  'INTERVIEWING',
  'OFFERED',
  'HIRED',
  'REJECTED',
  'WITHDRAWN'
);

CREATE TABLE "InternalJobApplication" (
  "id"            UUID                          NOT NULL DEFAULT gen_random_uuid(),
  "postingId"     UUID                          NOT NULL,
  "associateId"   UUID                          NOT NULL,
  "status"        "InternalApplicationStatus"   NOT NULL DEFAULT 'SUBMITTED',
  "coverLetter"   TEXT,
  "resumeUrl"     TEXT,
  "reviewerNotes" TEXT,
  "reviewedById"  UUID,
  "reviewedAt"    TIMESTAMPTZ(6),
  "createdAt"     TIMESTAMPTZ(6)                NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ(6)                NOT NULL,
  CONSTRAINT "InternalJobApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InternalJobApplication_posting_associate_key"
  ON "InternalJobApplication"("postingId", "associateId");
CREATE INDEX "InternalJobApplication_associateId_idx"
  ON "InternalJobApplication"("associateId");
CREATE INDEX "InternalJobApplication_posting_status_idx"
  ON "InternalJobApplication"("postingId", "status");

ALTER TABLE "InternalJobApplication" ADD CONSTRAINT "InternalJobApplication_postingId_fkey"
  FOREIGN KEY ("postingId") REFERENCES "JobPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InternalJobApplication" ADD CONSTRAINT "InternalJobApplication_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InternalJobApplication" ADD CONSTRAINT "InternalJobApplication_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
