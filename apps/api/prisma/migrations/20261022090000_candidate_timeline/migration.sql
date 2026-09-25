-- The candidate's timeline, and when they entered their current stage.
--
-- Recruiting kept only the stage a candidate is in now. Nothing recorded
-- when they got there or who moved them, so "days in stage" could only
-- show days since applying, time-to-hire and funnel conversion could not
-- be computed at all, and notes were a single overwritable text field.
-- Every stage move, note, interview and offer step is now an event.

-- ── 1. When the current stage began. Existing rows get the best stamp on
-- hand: the hire date for hires, else the last update (stage moves were
-- the main thing that touched a candidate row).
-- Backfilled in the same step that adds the column, so a re-run never
-- overwrites stamps written since.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'Candidate'
       AND column_name = 'stageChangedAt'
  ) THEN
    ALTER TABLE "Candidate"
      ADD COLUMN "stageChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    UPDATE "Candidate" SET "stageChangedAt" = COALESCE("hiredAt", "updatedAt");
  END IF;
END $$;

-- ── 2. The events.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CandidateEventKind') THEN
    CREATE TYPE "CandidateEventKind" AS ENUM (
      'CREATED',
      'APPLIED_AGAIN',
      'EDITED',
      'STAGE_CHANGED',
      'NOTE',
      'INTERVIEW_SCHEDULED',
      'INTERVIEW_SCORED',
      'INTERVIEW_CANCELLED',
      'OFFER_CREATED',
      'OFFER_SENT',
      'OFFER_DECIDED',
      'HIRED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CandidateEvent" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "candidateId" UUID NOT NULL,
  "kind"        "CandidateEventKind" NOT NULL,
  "fromStage"   "CandidateStage",
  "toStage"     "CandidateStage",
  "body"        TEXT,
  "metadata"    JSONB,
  "actorUserId" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CandidateEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CandidateEvent_candidateId_createdAt_idx"
  ON "CandidateEvent" ("candidateId", "createdAt");
CREATE INDEX IF NOT EXISTS "CandidateEvent_kind_createdAt_idx"
  ON "CandidateEvent" ("kind", "createdAt");

-- ADD CONSTRAINT has no IF NOT EXISTS, so guard it the long way.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CandidateEvent_candidateId_fkey') THEN
    ALTER TABLE "CandidateEvent"
      ADD CONSTRAINT "CandidateEvent_candidateId_fkey"
      FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CandidateEvent_actorUserId_fkey') THEN
    ALTER TABLE "CandidateEvent"
      ADD CONSTRAINT "CandidateEvent_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 3. Start every existing timeline with what is known for certain:
-- when they applied, and when hires were hired — enough for time-to-hire
-- on past hires. Guarded so a re-run adds nothing.
INSERT INTO "CandidateEvent" ("candidateId", "kind", "toStage", "createdAt")
SELECT c."id", 'CREATED', 'APPLIED', c."createdAt"
  FROM "Candidate" c
 WHERE NOT EXISTS (
   SELECT 1 FROM "CandidateEvent" e WHERE e."candidateId" = c."id" AND e."kind" = 'CREATED'
 );

INSERT INTO "CandidateEvent" ("candidateId", "kind", "toStage", "createdAt")
SELECT c."id", 'HIRED', 'HIRED', c."hiredAt"
  FROM "Candidate" c
 WHERE c."stage" = 'HIRED'
   AND c."hiredAt" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "CandidateEvent" e WHERE e."candidateId" = c."id" AND e."kind" = 'HIRED'
   );
