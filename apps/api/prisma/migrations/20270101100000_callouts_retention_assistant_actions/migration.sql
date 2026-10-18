-- AIOPS: call-outs handled automatically, retention intelligence, and an
-- assistant whose actions are proposed, then confirmed.

-- ----- Call-outs -------------------------------------------------------------
CREATE TYPE "CallOutChannel" AS ENUM ('WHATSAPP', 'SMS', 'APP', 'VOICE', 'STAFF');
CREATE TYPE "CallOutReason" AS ENUM ('SICK', 'FAMILY', 'TRANSPORT', 'EMERGENCY', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER');
CREATE TYPE "CallOutStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED');

CREATE TABLE "CallOut" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"           UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "shiftId"            UUID NOT NULL,
  "associateId"        UUID NOT NULL,
  "clientId"           UUID,
  "locationId"         UUID,
  "channel"            "CallOutChannel" NOT NULL,
  "reason"             "CallOutReason" NOT NULL DEFAULT 'OTHER',
  "note"               VARCHAR(1000),
  "recordingUrl"       VARCHAR(500),
  "status"             "CallOutStatus" NOT NULL DEFAULT 'CONFIRMED',
  "minutesBeforeStart" INTEGER NOT NULL,
  "late"               BOOLEAN NOT NULL DEFAULT false,
  "excused"            BOOLEAN NOT NULL DEFAULT false,
  "excusedWhy"         VARCHAR(200),
  "coverSteps"         JSONB,
  "confirmedAt"        TIMESTAMPTZ(6),
  "createdById"        UUID,
  "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallOut_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CallOut_shiftId_associateId_key" ON "CallOut"("shiftId", "associateId");
CREATE INDEX "CallOut_tenantId_createdAt_idx" ON "CallOut"("tenantId", "createdAt");
CREATE INDEX "CallOut_clientId_createdAt_idx" ON "CallOut"("clientId", "createdAt");
CREATE INDEX "CallOut_associateId_status_idx" ON "CallOut"("associateId", "status");
ALTER TABLE "CallOut" ADD CONSTRAINT "CallOut_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallOut" ADD CONSTRAINT "CallOut_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----- Retention ----------------------------------------------------------------
CREATE TYPE "RiskBand" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "RetentionPlayKind" AS ENUM ('MORE_HOURS', 'CHECK_IN', 'SCHEDULE_FIX', 'RIDE_HELP', 'RECOGNITION', 'PAY_REVIEW');
CREATE TYPE "RetentionPlayStatus" AS ENUM ('OPEN', 'DONE');
CREATE TYPE "RetentionOutcome" AS ENUM ('PENDING', 'STAYED', 'LEFT');

CREATE TABLE "FlightRisk" (
  "associateId" UUID NOT NULL,
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "score"       INTEGER NOT NULL,
  "band"        "RiskBand" NOT NULL,
  "reasons"     JSONB NOT NULL,
  "plays"       JSONB NOT NULL,
  "computedAt"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "FlightRisk_pkey" PRIMARY KEY ("associateId")
);
CREATE INDEX "FlightRisk_tenantId_band_idx" ON "FlightRisk"("tenantId", "band");
ALTER TABLE "FlightRisk" ADD CONSTRAINT "FlightRisk_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RetentionPlay" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"       UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"    UUID NOT NULL,
  "kind"           "RetentionPlayKind" NOT NULL,
  "status"         "RetentionPlayStatus" NOT NULL DEFAULT 'OPEN',
  "note"           VARCHAR(1000),
  "riskAtStart"    INTEGER NOT NULL,
  "reasonsAtStart" JSONB,
  "takenById"      UUID,
  "approvalId"     UUID,
  "doneAt"         TIMESTAMPTZ(6),
  "outcome"        "RetentionOutcome" NOT NULL DEFAULT 'PENDING',
  "outcomeAt"      TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RetentionPlay_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RetentionPlay_tenantId_kind_idx" ON "RetentionPlay"("tenantId", "kind");
CREATE INDEX "RetentionPlay_associateId_idx" ON "RetentionPlay"("associateId");
ALTER TABLE "RetentionPlay" ADD CONSTRAINT "RetentionPlay_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----- Assistant actions (proposed → confirmed) --------------------------------
CREATE TYPE "AssistantActionStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'CANCELLED', 'FAILED');

CREATE TABLE "AssistantAction" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId"       UUID NOT NULL,
  "kind"         VARCHAR(60) NOT NULL,
  "params"       JSONB NOT NULL,
  "title"        VARCHAR(300) NOT NULL,
  "detail"       VARCHAR(1000),
  "status"       "AssistantActionStatus" NOT NULL DEFAULT 'PROPOSED',
  "expiresAt"    TIMESTAMPTZ(6) NOT NULL,
  "decidedAt"    TIMESTAMPTZ(6),
  "resultStatus" INTEGER,
  "result"       JSONB,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AssistantAction_userId_createdAt_idx" ON "AssistantAction"("userId", "createdAt");
CREATE INDEX "AssistantAction_tenantId_idx" ON "AssistantAction"("tenantId");
