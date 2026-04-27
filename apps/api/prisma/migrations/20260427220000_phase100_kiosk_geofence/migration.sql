-- Phase 100 — Geofence kiosk punches to a fixed location.
--
-- All three columns nullable: a kiosk without a configured geofence
-- behaves exactly as before (no location check). Adding a geofence is
-- opt-in per device. radiusMeters is INTEGER because we don't need
-- sub-meter precision on the threshold.

ALTER TABLE "KioskDevice"
  ADD COLUMN "latitude"     DECIMAL(10, 7),
  ADD COLUMN "longitude"    DECIMAL(10, 7),
  ADD COLUMN "radiusMeters" INTEGER;

-- Capture the punch's reported coords so HR can see drift (e.g. kiosk
-- accepted a punch from 80m vs the configured 100m radius — useful when
-- tuning). Both nullable: rejected punches without GPS won't have them.
ALTER TABLE "KioskPunch"
  ADD COLUMN "punchLat" DECIMAL(10, 7),
  ADD COLUMN "punchLng" DECIMAL(10, 7),
  -- Distance from device's configured center, meters. NULL if the
  -- device has no geofence configured.
  ADD COLUMN "distanceMeters" INTEGER;

-- Sanity: if any of {lat,lng,radius} are set, all three must be set.
ALTER TABLE "KioskDevice"
  ADD CONSTRAINT "KioskDevice_geofence_check"
  CHECK (
    ("latitude" IS NULL AND "longitude" IS NULL AND "radiusMeters" IS NULL)
    OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "radiusMeters" IS NOT NULL AND "radiusMeters" > 0)
  );
