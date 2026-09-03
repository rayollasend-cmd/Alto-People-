-- The scorecard's memory: daily posture snapshots (trend/delta/audit
-- evidence) and persisted remediation state pinned onto derived action ids.

CREATE TABLE "ComplianceScoreSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day" DATE NOT NULL,
    "clientId" UUID,
    "score" INTEGER NOT NULL,
    "criticalCount" INTEGER NOT NULL,
    "warnCount" INTEGER NOT NULL,
    "activeAssociateCount" INTEGER NOT NULL,
    "fullyCompliantCount" INTEGER NOT NULL,
    "tileSeverities" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceScoreSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComplianceScoreSnapshot_day_clientId_key" ON "ComplianceScoreSnapshot"("day", "clientId");
CREATE INDEX "ComplianceScoreSnapshot_clientId_day_idx" ON "ComplianceScoreSnapshot"("clientId", "day" DESC);

ALTER TABLE "ComplianceScoreSnapshot" ADD CONSTRAINT "ComplianceScoreSnapshot_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ComplianceActionState" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actionKey" VARCHAR(300) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "assigneeUserId" UUID,
    "snoozedUntil" TIMESTAMPTZ(6),
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceActionState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComplianceActionState_actionKey_key" ON "ComplianceActionState"("actionKey");
CREATE INDEX "ComplianceActionState_assigneeUserId_idx" ON "ComplianceActionState"("assigneeUserId");
CREATE INDEX "ComplianceActionState_status_idx" ON "ComplianceActionState"("status");

ALTER TABLE "ComplianceActionState" ADD CONSTRAINT "ComplianceActionState_assigneeUserId_fkey"
    FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ComplianceActionState" ADD CONSTRAINT "ComplianceActionState_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
