-- Recruiting, enterprise polish: job-board syndication fields on postings,
-- saved views, and indexes for server-side candidate search and paging.
-- Idempotent — safe to re-run.

DO $$ BEGIN
  CREATE TYPE "JobPostingSchedule" AS ENUM ('FULL_TIME', 'PART_TIME', 'TEMPORARY', 'SEASONAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "JobPayUnit" AS ENUM ('HOUR', 'YEAR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "schedule" "JobPostingSchedule";
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "payUnit" "JobPayUnit";
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "syndicate" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "SavedView" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerId" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "query" JSONB NOT NULL,
  "shared" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SavedView_scope_ownerId_idx" ON "SavedView"("scope", "ownerId");
CREATE INDEX IF NOT EXISTS "SavedView_scope_shared_idx" ON "SavedView"("scope", "shared");
DO $$ BEGIN
  ALTER TABLE "SavedView"
    ADD CONSTRAINT "SavedView_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Candidate lists page by these; the board orders each column by them.
CREATE INDEX IF NOT EXISTS "Candidate_createdAt_idx" ON "Candidate"("createdAt");
CREATE INDEX IF NOT EXISTS "Candidate_stage_stageChangedAt_idx" ON "Candidate"("stage", "stageChangedAt");
