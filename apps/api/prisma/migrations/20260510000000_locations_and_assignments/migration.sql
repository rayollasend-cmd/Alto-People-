-- Phase 131 — Locations + Associate transfer history.
--
-- Two new tables:
--   * Location: physical work site under a Client (e.g. Walmart →
--     Destin / Front Beach / PCB). Holds the per-site geofence, state
--     code (drives OT / meal-break / fair-workweek rules) and address.
--   * AssociateAssignment: effective-dated record of which Location
--     an associate is currently working at. Transferring an associate
--     = close the open row, insert a new open row. A partial unique
--     index enforces "at most one open row per associate".
--
-- New nullable locationId FKs on Application, Shift, KioskDevice and
-- TimeEntry. All are nullable in this PR so backfill is non-breaking.
-- A follow-up migration tightens them (NOT NULL on Shift/KioskDevice,
-- drops Shift.location free-text, drops Client.{latitude,longitude,
-- geofenceRadiusMeters} once read paths are cut over).
--
-- Backfill at the bottom of this file creates one default Location
-- per existing Client (1:1, named after the Client) and points every
-- existing Application / Shift / KioskDevice / TimeEntry row at that
-- default Location. Consolidating the 4 Walmart Client rows into one
-- Client + 4 Locations is a separate one-off SQL script (see
-- apps/api/scripts/consolidate-walmart.sql) since it's environment-
-- specific.

-- 1. Location
CREATE TABLE "Location" (
  "id"                   UUID           NOT NULL DEFAULT gen_random_uuid(),
  "clientId"             UUID           NOT NULL,
  "name"                 TEXT           NOT NULL,
  "addressLine1"         VARCHAR(255),
  "addressLine2"         VARCHAR(255),
  "city"                 VARCHAR(120),
  "state"                VARCHAR(2),
  "zip"                  VARCHAR(10),
  "latitude"             DECIMAL(10, 7),
  "longitude"            DECIMAL(10, 7),
  "geofenceRadiusMeters" INT,
  "isActive"             BOOLEAN        NOT NULL DEFAULT TRUE,
  "createdAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "deletedAt"            TIMESTAMPTZ(6),

  CONSTRAINT "Location_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Location_client_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Location_clientId_isActive_idx" ON "Location"("clientId", "isActive");
CREATE INDEX "Location_deletedAt_idx"          ON "Location"("deletedAt");

-- 2. AssociateAssignment
CREATE TABLE "AssociateAssignment" (
  "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  "associateId" UUID           NOT NULL,
  "locationId"  UUID           NOT NULL,
  "startedAt"   DATE           NOT NULL,
  "endedAt"     DATE,
  "reason"      TEXT,
  "notedById"   UUID,
  "notes"       TEXT,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "AssociateAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssociateAssignment_associate_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AssociateAssignment_location_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AssociateAssignment_notedBy_fkey"
    FOREIGN KEY ("notedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,

  -- endedAt must be on/after startedAt when present.
  CONSTRAINT "AssociateAssignment_dates_chk"
    CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt")
);

CREATE INDEX "AssociateAssignment_associateId_endedAt_idx"
  ON "AssociateAssignment"("associateId", "endedAt");
CREATE INDEX "AssociateAssignment_locationId_startedAt_idx"
  ON "AssociateAssignment"("locationId", "startedAt");

-- At most one OPEN (endedAt IS NULL) assignment per associate.
-- Partial unique index — Postgres-native, no app-layer enforcement
-- needed. Inserting a second open row for the same associate fails
-- with a unique-constraint violation.
CREATE UNIQUE INDEX "AssociateAssignment_one_open_per_associate"
  ON "AssociateAssignment"("associateId")
  WHERE "endedAt" IS NULL;

-- 3. Nullable locationId FKs on existing tables.
ALTER TABLE "Application" ADD COLUMN "locationId" UUID;
ALTER TABLE "Shift"       ADD COLUMN "locationId" UUID;
ALTER TABLE "KioskDevice" ADD COLUMN "locationId" UUID;
ALTER TABLE "TimeEntry"   ADD COLUMN "locationId" UUID;

ALTER TABLE "Application" ADD CONSTRAINT "Application_location_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Shift uses Restrict to mirror the existing Shift_client_fkey behavior:
-- a Location with shifts on it can't be deleted, only soft-deleted.
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_location_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- KioskDevice: Restrict — a Location with active devices shouldn't be
-- hard-deletable. Devices follow the location lifecycle.
ALTER TABLE "KioskDevice" ADD CONSTRAINT "KioskDevice_location_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- TimeEntry: SetNull — historical entries shouldn't block Location
-- deletion. They keep their denormalized clientId either way.
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_location_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Application_locationId_idx"
  ON "Application"("locationId");
CREATE INDEX "Shift_locationId_startsAt_idx"
  ON "Shift"("locationId", "startsAt");
CREATE INDEX "KioskDevice_locationId_isActive_idx"
  ON "KioskDevice"("locationId", "isActive");
CREATE INDEX "TimeEntry_locationId_status_idx"
  ON "TimeEntry"("locationId", "status");

-- 4. Backfill: one default Location per existing Client. Copies state,
-- address and geofence from the Client row so geofence behavior is
-- preserved bit-for-bit once read paths switch to Location.
INSERT INTO "Location" (
  "clientId", "name",
  "addressLine1", "addressLine2", "city", "state", "zip",
  "latitude", "longitude", "geofenceRadiusMeters",
  "isActive", "updatedAt"
)
SELECT
  "id", "name",
  "addressLine1", "addressLine2", "city", "state", "zip",
  "latitude", "longitude", "geofenceRadiusMeters",
  CASE WHEN "deletedAt" IS NULL THEN TRUE ELSE FALSE END,
  NOW()
FROM "Client";

-- 5. Backfill locationId on dependent rows from each row's clientId.
-- Every Client got exactly one default Location, so the join is
-- unambiguous. Rows where the parent record's clientId is NULL (e.g.
-- TimeEntry rows captured pre-denormalization) stay NULL.
UPDATE "Application" a
SET "locationId" = (
  SELECT "id" FROM "Location" l WHERE l."clientId" = a."clientId" LIMIT 1
)
WHERE a."locationId" IS NULL;

UPDATE "Shift" s
SET "locationId" = (
  SELECT "id" FROM "Location" l WHERE l."clientId" = s."clientId" LIMIT 1
)
WHERE s."locationId" IS NULL;

UPDATE "KioskDevice" k
SET "locationId" = (
  SELECT "id" FROM "Location" l WHERE l."clientId" = k."clientId" LIMIT 1
)
WHERE k."locationId" IS NULL;

UPDATE "TimeEntry" t
SET "locationId" = (
  SELECT "id" FROM "Location" l WHERE l."clientId" = t."clientId" LIMIT 1
)
WHERE t."locationId" IS NULL AND t."clientId" IS NOT NULL;
