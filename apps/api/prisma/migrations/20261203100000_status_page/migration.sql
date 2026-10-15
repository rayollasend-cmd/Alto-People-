-- The public status page: incidents the team posts, with their timeline.
-- Platform-wide by nature (a customer's own numbers never appear), so the
-- rows default to the platform operator's tenant like every other table.
CREATE TYPE "StatusComponent" AS ENUM ('API', 'WEB', 'KIOSK', 'MESSAGING', 'PAYROLL_WEBHOOK', 'EMAIL');
CREATE TYPE "StatusImpact" AS ENUM ('DEGRADED', 'OUTAGE');
CREATE TYPE "StatusIncidentState" AS ENUM ('INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED');

CREATE TABLE "StatusIncident" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "title" VARCHAR(160) NOT NULL,
    "component" "StatusComponent" NOT NULL,
    "impact" "StatusImpact" NOT NULL,
    "state" "StatusIncidentState" NOT NULL DEFAULT 'INVESTIGATING',
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "StatusIncident_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StatusIncident_startedAt_idx" ON "StatusIncident"("startedAt");
CREATE INDEX "StatusIncident_state_idx" ON "StatusIncident"("state");

CREATE TABLE "StatusIncidentUpdate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "incidentId" UUID NOT NULL,
    "state" "StatusIncidentState" NOT NULL,
    "note" VARCHAR(2000) NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byUserId" UUID,
    CONSTRAINT "StatusIncidentUpdate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StatusIncidentUpdate_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "StatusIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StatusIncidentUpdate_incidentId_at_idx" ON "StatusIncidentUpdate"("incidentId", "at");
