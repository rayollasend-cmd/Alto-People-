-- Recruiting analytics: what a hire fills, how many were asked for, and
-- what each source cost. Idempotent — safe to re-run.

-- The posting a candidate applied to or is hired against.
ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "jobPostingId" UUID;
CREATE INDEX IF NOT EXISTS "Candidate_jobPostingId_idx" ON "Candidate"("jobPostingId");
DO $$ BEGIN
  ALTER TABLE "Candidate"
    ADD CONSTRAINT "Candidate_jobPostingId_fkey"
    FOREIGN KEY ("jobPostingId") REFERENCES "JobPosting"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- How many people the client asked for.
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "openings" INTEGER NOT NULL DEFAULT 1;

-- Careers-page applicants already name their posting on the timeline
-- (metadata.postingSlug on the CREATED event); link them.
UPDATE "Candidate" c
SET "jobPostingId" = jp."id"
FROM "CandidateEvent" e
JOIN "JobPosting" jp ON jp."slug" = e."metadata"->>'postingSlug'
WHERE e."candidateId" = c."id"
  AND e."kind" = 'CREATED'
  AND c."jobPostingId" IS NULL;

-- What each source cost, per month.
CREATE TABLE IF NOT EXISTS "RecruitingSourceSpend" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source" TEXT NOT NULL,
  "month" DATE NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "note" TEXT,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "RecruitingSourceSpend_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RecruitingSourceSpend_source_month_key" ON "RecruitingSourceSpend"("source", "month");
DO $$ BEGIN
  ALTER TABLE "RecruitingSourceSpend"
    ADD CONSTRAINT "RecruitingSourceSpend_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
