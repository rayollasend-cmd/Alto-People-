-- The client's sign-off on a store week's worked hours (deep audit 2026-10-29,
-- builder PORTAL). The store manager reviews each person's hours for a
-- finished week in the client portal and signs them off, or flags lines with
-- a note; staff read the status on the client's page and its statements.
-- One row per store per week (re-signing replaces it); totals and lines are
-- frozen as signed. New table only: no existing row is read or changed.
-- Tenant-keyed and under the wall (20270128190100_tenancy_rls).

CREATE TYPE "ClientHoursSignOffStatus" AS ENUM ('SIGNED', 'FLAGGED');

CREATE TABLE IF NOT EXISTS "ClientHoursSignOff" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "clientId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "weekStart" DATE NOT NULL,
  "status" "ClientHoursSignOffStatus" NOT NULL DEFAULT 'SIGNED',
  "signedById" UUID NOT NULL,
  "signedByName" VARCHAR(200) NOT NULL,
  "signedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "totalHours" DECIMAL(10,2) NOT NULL,
  "people" INTEGER NOT NULL,
  "lines" JSONB NOT NULL,
  "flags" JSONB NOT NULL DEFAULT '[]',
  "note" VARCHAR(1000),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ClientHoursSignOff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClientHoursSignOff_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClientHoursSignOff_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClientHoursSignOff_tenantId_locationId_weekStart_key" ON "ClientHoursSignOff"("tenantId", "locationId", "weekStart");
CREATE INDEX IF NOT EXISTS "ClientHoursSignOff_tenantId_idx" ON "ClientHoursSignOff"("tenantId");
CREATE INDEX IF NOT EXISTS "ClientHoursSignOff_clientId_weekStart_idx" ON "ClientHoursSignOff"("clientId", "weekStart");

-- Under the wall (20270128190100_tenancy_rls).
SELECT alto_tenant_rls_policies('ClientHoursSignOff');
ALTER TABLE "ClientHoursSignOff" ENABLE ROW LEVEL SECURITY;
