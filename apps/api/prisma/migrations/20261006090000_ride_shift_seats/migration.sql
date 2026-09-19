-- Seats by store shift: a ride booked for a shift carries its label; riders
-- on the same store shift, way and day share its vans' seats and wait in
-- line when they're full.
ALTER TABLE "Ride" ADD COLUMN "windowLabel" VARCHAR(80);
CREATE INDEX "Ride_locationId_direction_windowLabel_targetAt_idx" ON "Ride"("locationId", "direction", "windowLabel", "targetAt");
