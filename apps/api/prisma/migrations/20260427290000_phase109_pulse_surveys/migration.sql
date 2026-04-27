-- Phase 109 — Anonymous pulse surveys.
--
-- HR creates a single-question micro-survey (1-5 scale or YES/NO).
-- Associates answer once; the response is stored without any FK to the
-- responder. Instead we store a salted HMAC of (userId, surveyId) as
-- responderHash so we can:
--   1. Reject duplicate submissions (unique on responderHash + surveyId).
--   2. Not be able to recover WHO answered, even if the DB is dumped,
--      provided the HMAC secret stays out of the dump.
--
-- The salt lives in env (PULSE_HASH_SECRET, falling back to
-- PAYOUT_ENCRYPTION_KEY) for the same reason kiosk PIN HMACs do.

CREATE TYPE "PulseScale" AS ENUM ('SCORE_1_5', 'YES_NO');

CREATE TYPE "PulseAudience" AS ENUM ('ALL', 'BY_DEPARTMENT', 'BY_CLIENT');

CREATE TABLE "PulseSurvey" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "question" TEXT NOT NULL,
    "scale" "PulseScale" NOT NULL,
    "audience" "PulseAudience" NOT NULL DEFAULT 'ALL',
    "audienceDepartmentId" UUID,
    "audienceClientId" UUID,
    "openFrom" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openUntil" TIMESTAMPTZ(6) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PulseSurvey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PulseSurvey_open_idx"
    ON "PulseSurvey"("openFrom", "openUntil");

ALTER TABLE "PulseSurvey"
    ADD CONSTRAINT "PulseSurvey_audienceDepartmentId_fkey"
    FOREIGN KEY ("audienceDepartmentId") REFERENCES "Department"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PulseSurvey"
    ADD CONSTRAINT "PulseSurvey_audienceClientId_fkey"
    FOREIGN KEY ("audienceClientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PulseSurvey"
    ADD CONSTRAINT "PulseSurvey_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PulseResponse" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "surveyId" UUID NOT NULL,
    "responderHash" BYTEA NOT NULL,
    -- Score 1..5 for SCORE_1_5; 0 = NO, 1 = YES for YES_NO.
    "scoreValue" SMALLINT NOT NULL,
    "comment" TEXT,
    "submittedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PulseResponse_pkey" PRIMARY KEY ("id")
);

-- One response per (survey, responder). Uniqueness on responderHash
-- alone would block the same person from answering different surveys.
CREATE UNIQUE INDEX "PulseResponse_survey_responder_key"
    ON "PulseResponse"("surveyId", "responderHash");

CREATE INDEX "PulseResponse_surveyId_idx" ON "PulseResponse"("surveyId");

ALTER TABLE "PulseResponse"
    ADD CONSTRAINT "PulseResponse_surveyId_fkey"
    FOREIGN KEY ("surveyId") REFERENCES "PulseSurvey"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
