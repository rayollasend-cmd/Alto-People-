-- Safety numbers belong to a building.
--
-- OshaIncident carried only a clientId, so a store manager's portal
-- counted every incident on the account: "days since last incident" reset
-- on an injury at a store hours away, and the month's count included
-- stores this manager has never set foot in.

ALTER TABLE "OshaIncident" ADD COLUMN IF NOT EXISTS "locationId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OshaIncident_locationId_fkey'
  ) THEN
    ALTER TABLE "OshaIncident"
      ADD CONSTRAINT "OshaIncident_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "OshaIncident_locationId_occurredAt_idx"
  ON "OshaIncident"("locationId", "occurredAt" DESC);

-- Backfill 1: the injured person's placement on the day it happened is
-- the store that owns the incident.
UPDATE "OshaIncident" i
   SET "locationId" = a."locationId"
  FROM "AssociateAssignment" a
  JOIN "Location" l ON l.id = a."locationId"
 WHERE i."locationId" IS NULL
   AND i."associateId" IS NOT NULL
   AND a."associateId" = i."associateId"
   AND l."clientId" = i."clientId"
   AND a."startedAt" <= i."occurredAt"
   AND (a."endedAt" IS NULL OR a."endedAt" >= i."occurredAt");

-- Backfill 2: at a client with one active building, it can only be that
-- one. Anything still unplaced stays NULL and is counted only by
-- client-wide accounts — better an incident no store claims than one
-- filed against a store that never had it.
UPDATE "OshaIncident" i
   SET "locationId" = sole.id
  FROM (
    SELECT "clientId", MIN(id::text)::uuid AS id
      FROM "Location"
     WHERE "deletedAt" IS NULL AND "isActive" = true
     GROUP BY "clientId"
    HAVING COUNT(*) = 1
  ) sole
 WHERE i."locationId" IS NULL
   AND sole."clientId" = i."clientId";
