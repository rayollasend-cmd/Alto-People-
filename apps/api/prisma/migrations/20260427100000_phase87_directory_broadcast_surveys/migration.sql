-- Phase 87 — Directory + broadcast + surveys.
--
-- Directory has no schema — it's a read endpoint over Associate joined
-- to org dimensions. Two new tables:
--   Broadcast              — one-to-many announcement with optional
--                            target filters (departmentId, costCenterId,
--                            clientId). Has read/dismissed receipts.
--   BroadcastReceipt       — per-user read state.
--   Survey + SurveyQuestion + SurveyResponse + SurveyAnswer
--                          — pulse / eNPS / open-ended polling. Anonymous
--                            responses drop respondent FK.

CREATE TYPE "BroadcastChannel" AS ENUM (
  'IN_APP',
  'EMAIL',
  'SMS',
  'PUSH'
);

CREATE TYPE "BroadcastStatus" AS ENUM (
  'DRAFT',
  'SCHEDULED',
  'SENT',
  'CANCELLED'
);

CREATE TYPE "SurveyStatus" AS ENUM (
  'DRAFT',
  'OPEN',
  'CLOSED'
);

CREATE TYPE "SurveyQuestionKind" AS ENUM (
  'SHORT_TEXT',
  'LONG_TEXT',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'SCALE_1_5',
  'NPS_0_10'
);

CREATE TABLE "Broadcast" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "createdById"     UUID,
  "title"           TEXT NOT NULL,
  "body"            TEXT NOT NULL,
  "channels"        "BroadcastChannel"[] NOT NULL DEFAULT ARRAY['IN_APP']::"BroadcastChannel"[],
  -- Targeting filters (any combination). All null = send to everyone.
  "clientId"        UUID,
  "departmentId"    UUID,
  "costCenterId"    UUID,
  "status"          "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
  "scheduledFor"    TIMESTAMPTZ(6),
  "sentAt"          TIMESTAMPTZ(6),
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Broadcast_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "Broadcast_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL,
  CONSTRAINT "Broadcast_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL,
  CONSTRAINT "Broadcast_costCenterId_fkey"
    FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL
);
CREATE INDEX "Broadcast_status_idx" ON "Broadcast" ("status");
CREATE INDEX "Broadcast_clientId_idx" ON "Broadcast" ("clientId");

CREATE TABLE "BroadcastReceipt" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "broadcastId"    UUID NOT NULL,
  "userId"         UUID NOT NULL,
  "readAt"         TIMESTAMPTZ(6),
  "dismissedAt"    TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "BroadcastReceipt_broadcastId_fkey"
    FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE,
  CONSTRAINT "BroadcastReceipt_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "BroadcastReceipt_unique" UNIQUE ("broadcastId", "userId")
);
CREATE INDEX "BroadcastReceipt_userId_idx" ON "BroadcastReceipt" ("userId");

CREATE TABLE "Survey" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "createdById"  UUID,
  "clientId"     UUID,
  "title"        TEXT NOT NULL,
  "description"  TEXT,
  "isAnonymous"  BOOLEAN NOT NULL DEFAULT TRUE,
  "status"       "SurveyStatus" NOT NULL DEFAULT 'DRAFT',
  "openedAt"     TIMESTAMPTZ(6),
  "closedAt"     TIMESTAMPTZ(6),
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Survey_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "Survey_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL
);
CREATE INDEX "Survey_status_idx" ON "Survey" ("status");

CREATE TABLE "SurveyQuestion" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "surveyId"     UUID NOT NULL,
  "kind"         "SurveyQuestionKind" NOT NULL,
  "prompt"       TEXT NOT NULL,
  -- Choices for SINGLE_CHOICE / MULTI_CHOICE: JSON array of strings.
  "choices"      JSONB,
  "isRequired"   BOOLEAN NOT NULL DEFAULT TRUE,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "SurveyQuestion_surveyId_fkey"
    FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE
);
CREATE INDEX "SurveyQuestion_surveyId_idx" ON "SurveyQuestion" ("surveyId");

CREATE TABLE "SurveyResponse" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "surveyId"     UUID NOT NULL,
  -- NULL when isAnonymous == TRUE on the parent survey.
  "respondentId" UUID,
  "submittedAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "SurveyResponse_surveyId_fkey"
    FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE,
  CONSTRAINT "SurveyResponse_respondentId_fkey"
    FOREIGN KEY ("respondentId") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "SurveyResponse_surveyId_idx" ON "SurveyResponse" ("surveyId");

CREATE TABLE "SurveyAnswer" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "responseId"   UUID NOT NULL,
  "questionId"   UUID NOT NULL,
  -- One of these three is non-null depending on question kind.
  "textValue"    TEXT,
  "intValue"     INTEGER,
  -- For MULTI_CHOICE: array of choice indexes.
  "choiceValues" INTEGER[],
  CONSTRAINT "SurveyAnswer_responseId_fkey"
    FOREIGN KEY ("responseId") REFERENCES "SurveyResponse"("id") ON DELETE CASCADE,
  CONSTRAINT "SurveyAnswer_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "SurveyQuestion"("id") ON DELETE CASCADE,
  CONSTRAINT "SurveyAnswer_one_per_question" UNIQUE ("responseId", "questionId")
);
CREATE INDEX "SurveyAnswer_questionId_idx" ON "SurveyAnswer" ("questionId");
