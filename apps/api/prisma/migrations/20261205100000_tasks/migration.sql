-- Brief 3-2: tasks and the assignment engine. A task is one unit of work at
-- a site in a time window with a required capability; its assignment keeps
-- the ranking that chose the worker; its events are the timeline; the
-- policy is the tenant's (or a site's) rules for the engine.
CREATE TYPE "WorkTaskRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "WorkTaskStatus" AS ENUM ('OPEN', 'QUEUED', 'ASSIGNED', 'IN_PROGRESS', 'STALLED', 'FAILED', 'HANDED_OFF', 'DONE', 'CANCELLED');
CREATE TYPE "WorkTaskEventKind" AS ENUM ('ASSIGNED', 'QUEUED', 'STARTED', 'STALLED', 'FAILED', 'HANDED_OFF', 'DONE', 'CANCELLED');
CREATE TYPE "WorkTaskAssignmentState" AS ENUM ('ACTIVE', 'RELEASED');
CREATE TYPE "WorkTaskDecider" AS ENUM ('ENGINE', 'PERSON', 'HANDOFF');
CREATE TYPE "WorkTaskHighRiskPolicy" AS ENUM ('PERSON_ONLY', 'PERSON_OR_SUPERVISED_ROBOT');

CREATE TABLE "WorkTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "type" VARCHAR(80) NOT NULL,
    "locationId" UUID NOT NULL,
    "area" VARCHAR(120),
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "windowEnd" TIMESTAMPTZ(6) NOT NULL,
    "capability" VARCHAR(60) NOT NULL,
    "risk" "WorkTaskRisk" NOT NULL DEFAULT 'LOW',
    "estimatedMinutes" INTEGER NOT NULL,
    "reference" VARCHAR(160),
    "notes" VARCHAR(2000),
    "status" "WorkTaskStatus" NOT NULL DEFAULT 'OPEN',
    "queuedReason" VARCHAR(300),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "WorkTask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkTask_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkTask_window_check" CHECK ("windowEnd" > "windowStart"),
    CONSTRAINT "WorkTask_estimate_check" CHECK ("estimatedMinutes" > 0)
);
CREATE INDEX "WorkTask_tenantId_locationId_windowStart_idx" ON "WorkTask"("tenantId", "locationId", "windowStart");
CREATE INDEX "WorkTask_tenantId_status_idx" ON "WorkTask"("tenantId", "status");

CREATE TABLE "WorkTaskAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "taskId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "state" "WorkTaskAssignmentState" NOT NULL DEFAULT 'ACTIVE',
    "decidedBy" "WorkTaskDecider" NOT NULL,
    "decidedByUserId" UUID,
    "score" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB NOT NULL,
    "ranking" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMPTZ(6),
    CONSTRAINT "WorkTaskAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkTaskAssignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkTaskAssignment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "WorkTaskAssignment_taskId_state_idx" ON "WorkTaskAssignment"("taskId", "state");
CREATE INDEX "WorkTaskAssignment_workerId_state_idx" ON "WorkTaskAssignment"("workerId", "state");

CREATE TABLE "WorkTaskEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "taskId" UUID NOT NULL,
    "kind" "WorkTaskEventKind" NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(2000),
    "byUserId" UUID,
    "workerId" UUID,
    CONSTRAINT "WorkTaskEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkTaskEvent_taskId_at_idx" ON "WorkTaskEvent"("taskId", "at");

CREATE TABLE "WorkTaskPolicy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "locationId" UUID,
    "handoffSeconds" INTEGER NOT NULL DEFAULT 30,
    "maxAutoAssignCents" INTEGER,
    "highRiskPolicy" "WorkTaskHighRiskPolicy" NOT NULL DEFAULT 'PERSON_OR_SUPERVISED_ROBOT',
    "robotCostPerTaskCents" JSONB NOT NULL DEFAULT '{}',
    "robotDefaultCostCents" INTEGER NOT NULL DEFAULT 400,
    "agentCostPerTaskCents" INTEGER NOT NULL DEFAULT 0,
    "maxRobotsPerCrewLead" INTEGER NOT NULL DEFAULT 4,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "WorkTaskPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkTaskPolicy_handoff_check" CHECK ("handoffSeconds" BETWEEN 5 AND 900),
    CONSTRAINT "WorkTaskPolicy_span_check" CHECK ("maxRobotsPerCrewLead" BETWEEN 1 AND 50)
);
CREATE INDEX "WorkTaskPolicy_tenantId_locationId_idx" ON "WorkTaskPolicy"("tenantId", "locationId");
