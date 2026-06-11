-- Kiosk geofence demoted from hard block to advisory review flag.
-- Out-of-fence punches now succeed and land in the review queue with
-- anomalyKind = GEOFENCE (matching how associate self-serve clock-ins
-- have always treated geofence violations).
ALTER TYPE "KioskAnomalyKind" ADD VALUE 'GEOFENCE';
