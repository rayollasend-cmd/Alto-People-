-- Brief 1D-3 — Kill switch, certification and the agent scorecard. Additive.

ALTER TABLE "AgentProfile"
  ADD COLUMN "certifiedAt"           TIMESTAMPTZ(6),
  ADD COLUMN "certifiedModelVersion" VARCHAR(80),
  ADD COLUMN "suspendedAt"           TIMESTAMPTZ(6),
  ADD COLUMN "suspendedById"         UUID,
  ADD COLUMN "suspendReason"         VARCHAR(300),
  ADD COLUMN "driftErrorRatePct"     INTEGER DEFAULT 25,
  ADD COLUMN "driftCostPerTaskCents" INTEGER,
  ADD COLUMN "lastDriftAlertAt"      TIMESTAMPTZ(6);

-- Agents already running when the registry arrived are certified for the
-- version they run; the next version change sends them back to onboarding.
UPDATE "AgentProfile" p
SET "certifiedAt" = CURRENT_TIMESTAMP, "certifiedModelVersion" = p."modelVersion"
FROM "Worker" w
WHERE w."id" = p."workerId" AND w."status" = 'ACTIVE' AND p."certifiedAt" IS NULL;

CREATE TABLE "AgentControl" (
  "id"             VARCHAR(16) NOT NULL DEFAULT 'singleton',
  "allSuspendedAt" TIMESTAMPTZ(6),
  "suspendedById"  UUID,
  "reason"         VARCHAR(300),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgentControl_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentScenario" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "workerId"    UUID NOT NULL,
  "name"        VARCHAR(160) NOT NULL,
  "input"       JSONB NOT NULL,
  "expected"    JSONB NOT NULL,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgentScenario_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentScenario_workerId_idx" ON "AgentScenario"("workerId");
ALTER TABLE "AgentScenario" ADD CONSTRAINT "AgentScenario_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "AgentProfile"("workerId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentScenarioRun" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "scenarioId"   UUID NOT NULL,
  "workerId"     UUID NOT NULL,
  "modelVersion" VARCHAR(80) NOT NULL,
  "passed"       BOOLEAN NOT NULL,
  "actual"       JSONB,
  "reason"       VARCHAR(500),
  "ranById"      UUID,
  "ranAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentScenarioRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentScenarioRun_scenarioId_ranAt_idx" ON "AgentScenarioRun"("scenarioId", "ranAt" DESC);
CREATE INDEX "AgentScenarioRun_workerId_modelVersion_idx" ON "AgentScenarioRun"("workerId", "modelVersion");
ALTER TABLE "AgentScenarioRun" ADD CONSTRAINT "AgentScenarioRun_scenarioId_fkey"
  FOREIGN KEY ("scenarioId") REFERENCES "AgentScenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
