-- Phase 131 finalization — the per-device geofence override
-- (KioskDevice.latitude/longitude/radiusMeters) is dead. After Phase
-- 131 every kiosk attaches to a Location, and Location carries the
-- canonical geofence (Location.latitude/longitude/geofenceRadiusMeters).
-- The override fields existed only as a soft-deprecated fallback for
-- pre-Phase-131 devices; the backfill migration ensured every device
-- has a locationId, so nothing reads them anymore.
--
-- Drop the columns + the CHECK constraint that gated them. Anyone
-- needing site-specific drift goes through Location, not per-device.

ALTER TABLE "KioskDevice"
  DROP CONSTRAINT IF EXISTS "KioskDevice_geofence_check";

ALTER TABLE "KioskDevice"
  DROP COLUMN IF EXISTS "latitude",
  DROP COLUMN IF EXISTS "longitude",
  DROP COLUMN IF EXISTS "radiusMeters";
