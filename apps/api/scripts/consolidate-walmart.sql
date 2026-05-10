-- One-time consolidation of the 4 separate Walmart Client rows into
-- one "Walmart" Client + 4 Locations (Destin, Front Beach, PCB,
-- Santa Rosa Beach).
--
-- Run AFTER migration 20260510000000_locations_and_assignments has
-- applied. This script is environment-specific and intentionally NOT
-- a Prisma migration — production may have different data and should
-- be reviewed before running.
--
-- Idempotent: if "Walmart Destin" no longer exists (already
-- consolidated, or a different environment), the script no-ops.
--
-- Safe: aborts with RAISE EXCEPTION if any of the 3 dupe Walmart
-- Clients have references (Applications, Shifts, KioskDevices,
-- KioskPins, PayrollSchedules) that would be orphaned. Fix those
-- first, then re-run.
--
-- Usage (dev):
--   psql "$DATABASE_URL" -f apps/api/scripts/consolidate-walmart.sql
-- Or via tsx:
--   npx tsx -e "require('@prisma/client').PrismaClient.prototype.\$executeRawUnsafe(require('fs').readFileSync('apps/api/scripts/consolidate-walmart.sql', 'utf8'))"

BEGIN;

DO $$
DECLARE
  canonical_client_id UUID;
  unsafe_refs         INT;
BEGIN
  -- Pick "Walmart Destin" as the canonical Walmart Client. We keep its
  -- UUID so the one existing Application row (and any other data tied
  -- to it) needs no repointing.
  SELECT "id" INTO canonical_client_id
  FROM "Client"
  WHERE "name" = 'Walmart Destin' AND "deletedAt" IS NULL
  LIMIT 1;

  IF canonical_client_id IS NULL THEN
    RAISE NOTICE 'No active "Walmart Destin" client found — consolidation skipped (already done or different environment).';
    RETURN;
  END IF;

  -- Safety: refuse to consolidate if the 3 dupe Walmart Clients have
  -- any data hanging off them. (After 20260510000000 backfilled each
  -- dupe with a default Location, that Location IS expected and is
  -- handled below; everything else is unexpected.)
  SELECT COALESCE(SUM(refs), 0) INTO unsafe_refs FROM (
    SELECT COUNT(*) AS refs FROM "Application"
      WHERE "clientId" IN (
        SELECT "id" FROM "Client"
        WHERE "name" IN ('Walmart Front Beach', 'Walmart PCB', 'Walmart Santa Rosa Beach')
          AND "deletedAt" IS NULL
      )
    UNION ALL
    SELECT COUNT(*) FROM "Shift"
      WHERE "clientId" IN (
        SELECT "id" FROM "Client"
        WHERE "name" IN ('Walmart Front Beach', 'Walmart PCB', 'Walmart Santa Rosa Beach')
          AND "deletedAt" IS NULL
      )
    UNION ALL
    SELECT COUNT(*) FROM "KioskDevice"
      WHERE "clientId" IN (
        SELECT "id" FROM "Client"
        WHERE "name" IN ('Walmart Front Beach', 'Walmart PCB', 'Walmart Santa Rosa Beach')
          AND "deletedAt" IS NULL
      )
    UNION ALL
    SELECT COUNT(*) FROM "KioskPin"
      WHERE "clientId" IN (
        SELECT "id" FROM "Client"
        WHERE "name" IN ('Walmart Front Beach', 'Walmart PCB', 'Walmart Santa Rosa Beach')
          AND "deletedAt" IS NULL
      )
    UNION ALL
    SELECT COUNT(*) FROM "PayrollSchedule"
      WHERE "clientId" IN (
        SELECT "id" FROM "Client"
        WHERE "name" IN ('Walmart Front Beach', 'Walmart PCB', 'Walmart Santa Rosa Beach')
          AND "deletedAt" IS NULL
      )
  ) refs_check;

  IF unsafe_refs > 0 THEN
    RAISE EXCEPTION
      'Refusing to consolidate: % rows reference the dupe Walmart Clients (Apps/Shifts/KioskDevices/KioskPins/PayrollSchedules). Migrate those rows manually first.', unsafe_refs;
  END IF;

  -- Step 1: rename the canonical Client.
  UPDATE "Client"
  SET "name" = 'Walmart', "updatedAt" = NOW()
  WHERE "id" = canonical_client_id;

  -- Step 2: rename canonical Location ("Walmart Destin" → "Destin").
  UPDATE "Location"
  SET "name" = 'Destin', "updatedAt" = NOW()
  WHERE "clientId" = canonical_client_id AND "name" = 'Walmart Destin';

  -- Step 3: reparent the 3 dupe Locations (created 1:1 with their
  -- dupe Client rows by the prior migration) onto the canonical
  -- Walmart Client, and drop the "Walmart " prefix from each name.
  UPDATE "Location" l
  SET "clientId"  = canonical_client_id,
      "name"      = CASE l."name"
                      WHEN 'Walmart Front Beach'      THEN 'Front Beach'
                      WHEN 'Walmart PCB'              THEN 'PCB'
                      WHEN 'Walmart Santa Rosa Beach' THEN 'Santa Rosa Beach'
                      ELSE l."name"
                    END,
      "updatedAt" = NOW()
  WHERE l."name" IN ('Walmart Front Beach', 'Walmart PCB', 'Walmart Santa Rosa Beach')
    AND l."clientId" IN (
      SELECT "id" FROM "Client"
      WHERE "name" IN ('Walmart Front Beach', 'Walmart PCB', 'Walmart Santa Rosa Beach')
    );

  -- Step 4: soft-delete the 3 dupe Client rows.
  UPDATE "Client"
  SET "deletedAt" = NOW(), "updatedAt" = NOW()
  WHERE "name" IN ('Walmart Front Beach', 'Walmart PCB', 'Walmart Santa Rosa Beach')
    AND "deletedAt" IS NULL;

  RAISE NOTICE 'Walmart consolidation complete: 1 canonical client (Walmart) + 4 locations (Destin, Front Beach, PCB, Santa Rosa Beach). 3 dupe Client rows soft-deleted.';
END $$;

COMMIT;
