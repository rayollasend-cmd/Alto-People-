-- Transport, the role walk's fixes (2026-10-21):
--   RideRun.autoClosedAt   the stuck-run sweep closed it (lib/transportStuckRuns);
--                          riders never marked stay SCHEDULED for review
--   Ride.arrived*/noShow*  where the driver's phone was at Arrived and at
--                          No-show, and how far from the stop — the evidence
--                          behind a disputed no-show fee
--   TransportIssue.*       a driver's report carries photos and a location,
--                          and can take a van off the road (vanId, vanParked)

ALTER TABLE "RideRun" ADD COLUMN "autoClosedAt" TIMESTAMPTZ(6);

ALTER TABLE "Ride"
  ADD COLUMN "arrivedLat" DECIMAL(9, 6),
  ADD COLUMN "arrivedLng" DECIMAL(9, 6),
  ADD COLUMN "arrivedAccuracyM" INTEGER,
  ADD COLUMN "arrivedDistanceM" INTEGER,
  ADD COLUMN "noShowLat" DECIMAL(9, 6),
  ADD COLUMN "noShowLng" DECIMAL(9, 6),
  ADD COLUMN "noShowAccuracyM" INTEGER,
  ADD COLUMN "noShowDistanceM" INTEGER;

ALTER TABLE "TransportIssue"
  ADD COLUMN "photoKeys" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "lat" DECIMAL(9, 6),
  ADD COLUMN "lng" DECIMAL(9, 6),
  ADD COLUMN "vanId" UUID,
  ADD COLUMN "vanParked" BOOLEAN NOT NULL DEFAULT false;
