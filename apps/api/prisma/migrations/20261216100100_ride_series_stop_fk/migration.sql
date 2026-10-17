-- A standing booking's named pickup stop is a real stop: when the stop is
-- retired the series falls back to its address (SET NULL), as a ride does.
ALTER TABLE "RideSeries" ADD CONSTRAINT "RideSeries_stopId_fkey"
  FOREIGN KEY ("stopId") REFERENCES "TransportStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
