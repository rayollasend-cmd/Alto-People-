-- Brief 3-5: HR and VMS integrations — connections, sync runs, per-record errors.
CREATE TYPE "IntegrationVendor" AS ENUM ('FIELDGLASS', 'ADP', 'WORKDAY', 'UKG', 'BEELINE');
CREATE TYPE "IntegrationConnectionStatus" AS ENUM ('CONNECTED', 'PAUSED', 'ERROR');
CREATE TYPE "IntegrationSyncDirection" AS ENUM ('PULL', 'PUSH');
CREATE TYPE "IntegrationSyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

CREATE TABLE "IntegrationConnection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "vendor" "IntegrationVendor" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "IntegrationConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "credentialsEnc" BYTEA,
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scheduleMinutes" INTEGER,
    "eventDriven" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMPTZ(6),
    "nextSyncAt" TIMESTAMPTZ(6),
    "lastError" VARCHAR(500),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IntegrationConnection_tenantId_vendor_idx" ON "IntegrationConnection"("tenantId", "vendor");
CREATE INDEX "IntegrationConnection_tenantId_status_nextSyncAt_idx" ON "IntegrationConnection"("tenantId", "status", "nextSyncAt");

CREATE TABLE "IntegrationSyncRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "connectionId" UUID NOT NULL,
    "direction" "IntegrationSyncDirection" NOT NULL,
    "capability" VARCHAR(40) NOT NULL,
    "status" "IntegrationSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" VARCHAR(20) NOT NULL,
    "eventType" VARCHAR(60),
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "total" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    CONSTRAINT "IntegrationSyncRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IntegrationSyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "IntegrationSyncRun_connectionId_startedAt_idx" ON "IntegrationSyncRun"("connectionId", "startedAt");
CREATE INDEX "IntegrationSyncRun_tenantId_startedAt_idx" ON "IntegrationSyncRun"("tenantId", "startedAt");

CREATE TABLE "IntegrationSyncError" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "runId" UUID NOT NULL,
    "recordRef" VARCHAR(120) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "excerpt" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntegrationSyncError_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IntegrationSyncError_runId_fkey" FOREIGN KEY ("runId") REFERENCES "IntegrationSyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "IntegrationSyncError_runId_createdAt_idx" ON "IntegrationSyncError"("runId", "createdAt");
