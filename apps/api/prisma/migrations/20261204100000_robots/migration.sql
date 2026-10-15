-- Brief 3-1: the robot registry. A robot is a Worker of type ROBOT; these
-- tables carry the fleet profile, the site commissioning, the safety zones,
-- the pre-shift checklist, the status time series, the event log, the
-- maintenance history and incident evidence. tenantId on every row.
CREATE TYPE "RobotOwnership" AS ENUM ('OWNED', 'LEASED');
CREATE TYPE "RobotConnectorStatus" AS ENUM ('IDLE', 'WORKING', 'CHARGING', 'ERROR', 'OFFLINE', 'STOPPED');
CREATE TYPE "RobotEventKind" AS ENUM ('E_STOP', 'RESUME', 'ERROR', 'SHIFT_STARTED', 'SHIFT_ENDED', 'CHECKLIST_COMPLETED', 'COMMISSIONED', 'MAINTENANCE');
CREATE TYPE "RobotIncidentKind" AS ENUM ('NEAR_MISS', 'INJURY', 'PROPERTY_DAMAGE', 'MALFUNCTION');

CREATE TABLE "RobotProfile" (
    "workerId" UUID NOT NULL,
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "manufacturer" VARCHAR(80) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "serial" VARCHAR(120) NOT NULL,
    "firmware" VARCHAR(60),
    "ownership" "RobotOwnership" NOT NULL DEFAULT 'OWNED',
    "leaseEndsOn" DATE,
    "connectorProvider" VARCHAR(40) NOT NULL DEFAULT 'SIMULATED',
    "connectorExternalId" VARCHAR(120),
    "certifications" JSONB NOT NULL DEFAULT '[]',
    "notes" VARCHAR(2000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RobotProfile_pkey" PRIMARY KEY ("workerId"),
    CONSTRAINT "RobotProfile_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RobotProfile_tenantId_idx" ON "RobotProfile"("tenantId");
CREATE INDEX "RobotProfile_serial_idx" ON "RobotProfile"("serial");

CREATE TABLE "RobotCommissioning" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "workerId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "mapUrl" VARCHAR(500),
    "mapNotes" VARCHAR(2000),
    "chargingStations" JSONB NOT NULL DEFAULT '[]',
    "safetyLeadUserId" UUID,
    "signedOffAt" TIMESTAMPTZ(6),
    "notes" VARCHAR(2000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RobotCommissioning_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RobotCommissioning_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RobotCommissioning_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RobotCommissioning_safetyLeadUserId_fkey" FOREIGN KEY ("safetyLeadUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RobotCommissioning_workerId_locationId_key" ON "RobotCommissioning"("workerId", "locationId");
CREATE INDEX "RobotCommissioning_locationId_idx" ON "RobotCommissioning"("locationId");
CREATE INDEX "RobotCommissioning_tenantId_idx" ON "RobotCommissioning"("tenantId");

CREATE TABLE "SiteSafetyZone" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "locationId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "shape" JSONB NOT NULL,
    "guestOccupied" BOOLEAN NOT NULL DEFAULT false,
    "robotsAllowedWhenOccupied" BOOLEAN NOT NULL DEFAULT false,
    "occupiedSince" TIMESTAMPTZ(6),
    "occupiedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "SiteSafetyZone_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SiteSafetyZone_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SiteSafetyZone_locationId_idx" ON "SiteSafetyZone"("locationId");
CREATE INDEX "SiteSafetyZone_tenantId_idx" ON "SiteSafetyZone"("tenantId");

CREATE TABLE "RobotChecklistTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "locationId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "items" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RobotChecklistTemplate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RobotChecklistTemplate_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RobotChecklistTemplate_locationId_idx" ON "RobotChecklistTemplate"("locationId");
CREATE INDEX "RobotChecklistTemplate_tenantId_idx" ON "RobotChecklistTemplate"("tenantId");

CREATE TABLE "RobotChecklistRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "workerId" UUID NOT NULL,
    "shiftId" UUID,
    "templateId" UUID NOT NULL,
    "completedByUserId" UUID NOT NULL,
    "completedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answers" JSONB NOT NULL,
    "allPassed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RobotChecklistRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RobotChecklistRun_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RobotChecklistRun_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RobotChecklistRun_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "RobotChecklistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RobotChecklistRun_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "RobotChecklistRun_workerId_completedAt_idx" ON "RobotChecklistRun"("workerId", "completedAt" DESC);
CREATE INDEX "RobotChecklistRun_shiftId_idx" ON "RobotChecklistRun"("shiftId");
CREATE INDEX "RobotChecklistRun_tenantId_idx" ON "RobotChecklistRun"("tenantId");

CREATE TABLE "RobotStatusSample" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "workerId" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "status" "RobotConnectorStatus" NOT NULL,
    "batteryPct" INTEGER,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "currentTask" VARCHAR(200),
    "errorCode" VARCHAR(80),
    "raw" JSONB,
    CONSTRAINT "RobotStatusSample_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RobotStatusSample_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RobotStatusSample_workerId_at_idx" ON "RobotStatusSample"("workerId", "at" DESC);
CREATE INDEX "RobotStatusSample_tenantId_idx" ON "RobotStatusSample"("tenantId");

CREATE TABLE "RobotEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "workerId" UUID NOT NULL,
    "kind" "RobotEventKind" NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byUserId" UUID,
    "shiftId" UUID,
    "note" VARCHAR(500),
    "metadata" JSONB,
    CONSTRAINT "RobotEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RobotEvent_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RobotEvent_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RobotEvent_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "RobotEvent_workerId_at_idx" ON "RobotEvent"("workerId", "at" DESC);
CREATE INDEX "RobotEvent_kind_at_idx" ON "RobotEvent"("kind", "at" DESC);
CREATE INDEX "RobotEvent_tenantId_idx" ON "RobotEvent"("tenantId");

CREATE TABLE "RobotMaintenance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "workerId" UUID NOT NULL,
    "performedOn" DATE NOT NULL,
    "kind" VARCHAR(80) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "performedBy" VARCHAR(120),
    "costCents" INTEGER,
    "nextDueOn" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RobotMaintenance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RobotMaintenance_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RobotMaintenance_workerId_performedOn_idx" ON "RobotMaintenance"("workerId", "performedOn" DESC);
CREATE INDEX "RobotMaintenance_tenantId_idx" ON "RobotMaintenance"("tenantId");

CREATE TABLE "RobotIncident" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "workerId" UUID NOT NULL,
    "locationId" UUID,
    "kind" "RobotIncidentKind" NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "description" VARCHAR(4000) NOT NULL,
    "reportedByUserId" UUID,
    "oshaIncidentId" UUID,
    "peopleOnShift" JSONB NOT NULL DEFAULT '[]',
    "samples" JSONB NOT NULL DEFAULT '[]',
    "events" JSONB NOT NULL DEFAULT '[]',
    "retainUntil" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RobotIncident_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RobotIncident_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RobotIncident_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RobotIncident_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RobotIncident_oshaIncidentId_fkey" FOREIGN KEY ("oshaIncidentId") REFERENCES "OshaIncident"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "RobotIncident_workerId_occurredAt_idx" ON "RobotIncident"("workerId", "occurredAt" DESC);
CREATE INDEX "RobotIncident_locationId_idx" ON "RobotIncident"("locationId");
CREATE INDEX "RobotIncident_tenantId_idx" ON "RobotIncident"("tenantId");
