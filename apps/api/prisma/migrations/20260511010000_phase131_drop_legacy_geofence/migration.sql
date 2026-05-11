-- Phase 131 PR 3 — drop legacy Client-level geofence + tighten
-- locationId to NOT NULL on the tables where it should always be set.
--
-- Why now:
--   * Geofence reads were cut over to the Location's geofence with a
--     Client fallback in the previous batch of commits. The Client
--     fallback now reads "first active Location under the client"
--     instead (see geofenceForAssociate.ts), so the Client columns
--     are unused.
--   * All existing Shift and KioskDevice rows had locationId
--     backfilled by 20260510000000. Anything created since used a
--     Location-picker UI that requires one. The columns are safe to
--     mark NOT NULL.

-- 1. NOT NULL tightening on KioskDevice only. Shift.locationId stays
-- nullable for now — the legacy free-text `Shift.location` column is
-- still alive and the 17 writers/readers of it need a coordinated
-- cleanup PR before locationId can become mandatory there.
ALTER TABLE "KioskDevice"
  ALTER COLUMN "locationId" SET NOT NULL;

-- 2. Drop the Client geofence columns. Geofence lives on Location now.
ALTER TABLE "Client" DROP COLUMN "latitude";
ALTER TABLE "Client" DROP COLUMN "longitude";
ALTER TABLE "Client" DROP COLUMN "geofenceRadiusMeters";
