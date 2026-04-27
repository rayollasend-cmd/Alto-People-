-- Phase 117 — Holiday calendar. Per-client OR company-wide (clientId NULL)
-- holidays. Type discriminator covers FEDERAL / STATE / COMPANY / CLIENT_SPECIFIC.
-- Unique on (clientId, date, name) prevents duplicate seeding when an admin
-- imports the same federal calendar twice for the same client. NULL clientId
-- is treated as a real value by the unique index in Postgres only if we use
-- a partial index; instead we pin the company-wide rows by using a separate
-- unique index that treats NULL as a sentinel via COALESCE.
CREATE TYPE "HolidayType" AS ENUM (
  'FEDERAL',
  'STATE',
  'COMPANY',
  'CLIENT_SPECIFIC'
);

CREATE TABLE "Holiday" (
  "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  "clientId"    UUID,
  "name"        TEXT           NOT NULL,
  "date"        DATE           NOT NULL,
  "type"        "HolidayType"  NOT NULL,
  "state"       VARCHAR(2),
  "paid"        BOOLEAN        NOT NULL DEFAULT TRUE,
  "notes"       TEXT,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- One row per (client, date, name). COALESCE on clientId so company-wide rows
-- (NULL clientId) participate in the uniqueness check.
CREATE UNIQUE INDEX "Holiday_client_date_name_key"
  ON "Holiday"(COALESCE("clientId", '00000000-0000-0000-0000-000000000000'::uuid), "date", "name");
CREATE INDEX "Holiday_date_idx" ON "Holiday"("date");
CREATE INDEX "Holiday_clientId_idx" ON "Holiday"("clientId");

ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
