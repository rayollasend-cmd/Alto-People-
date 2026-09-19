-- The fleet: what a van looks like at the curb, and its driver.
ALTER TABLE "Van"
  ADD COLUMN "make" VARCHAR(40),
  ADD COLUMN "model" VARCHAR(40),
  ADD COLUMN "color" VARCHAR(30),
  ADD COLUMN "year" INTEGER,
  ADD COLUMN "driverUserId" UUID;
CREATE INDEX "Van_driverUserId_idx" ON "Van"("driverUserId");
ALTER TABLE "Van" ADD CONSTRAINT "Van_driverUserId_fkey"
  FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seat requests: who accepted a seat, and whether every driver declined.
ALTER TABLE "Ride"
  ADD COLUMN "acceptedAt" TIMESTAMPTZ(6),
  ADD COLUMN "acceptedById" UUID,
  ADD COLUMN "allDeclinedAt" TIMESTAMPTZ(6);

-- A driver turned a seat request down.
CREATE TABLE "RideRejection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rideId" UUID NOT NULL,
    "driverUserId" UUID NOT NULL,
    "reason" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RideRejection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RideRejection_rideId_driverUserId_key" ON "RideRejection"("rideId", "driverUserId");
CREATE INDEX "RideRejection_driverUserId_idx" ON "RideRejection"("driverUserId");
ALTER TABLE "RideRejection" ADD CONSTRAINT "RideRejection_rideId_fkey"
  FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RideRejection" ADD CONSTRAINT "RideRejection_driverUserId_fkey"
  FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
