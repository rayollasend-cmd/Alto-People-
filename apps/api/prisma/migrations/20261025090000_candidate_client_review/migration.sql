-- A client's say on the candidates put in front of them.
--
-- A recruiter had no way to show a client (a store manager) a candidate
-- and hear back: it happened by phone, and nothing of it reached the
-- candidate's record. A submittal puts a candidate — with the recruiter's
-- pitch, optionally for one store — in front of the client's portal,
-- where they approve or pass with a word on why; the answer lands on the
-- candidate's timeline.

ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'SUBMITTED_TO_CLIENT';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'CLIENT_FEEDBACK';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CandidateSubmittalStatus') THEN
    CREATE TYPE "CandidateSubmittalStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CandidateSubmittal" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "candidateId"   UUID NOT NULL,
  "clientId"      UUID NOT NULL,
  "locationId"    UUID,
  "pitch"         TEXT,
  "status"        "CandidateSubmittalStatus" NOT NULL DEFAULT 'PENDING',
  "feedback"      TEXT,
  "submittedById" UUID,
  "decidedById"   UUID,
  "decidedAt"     TIMESTAMPTZ(6),
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "CandidateSubmittal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CandidateSubmittal_clientId_status_idx" ON "CandidateSubmittal" ("clientId", "status");
CREATE INDEX IF NOT EXISTS "CandidateSubmittal_candidateId_idx" ON "CandidateSubmittal" ("candidateId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CandidateSubmittal_candidateId_fkey') THEN
    ALTER TABLE "CandidateSubmittal" ADD CONSTRAINT "CandidateSubmittal_candidateId_fkey"
      FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CandidateSubmittal_clientId_fkey') THEN
    ALTER TABLE "CandidateSubmittal" ADD CONSTRAINT "CandidateSubmittal_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CandidateSubmittal_locationId_fkey') THEN
    ALTER TABLE "CandidateSubmittal" ADD CONSTRAINT "CandidateSubmittal_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CandidateSubmittal_submittedById_fkey') THEN
    ALTER TABLE "CandidateSubmittal" ADD CONSTRAINT "CandidateSubmittal_submittedById_fkey"
      FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CandidateSubmittal_decidedById_fkey') THEN
    ALTER TABLE "CandidateSubmittal" ADD CONSTRAINT "CandidateSubmittal_decidedById_fkey"
      FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
