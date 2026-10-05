-- Rides: short-notice requests inside the planning cutoff, the dispatch
-- phone riders are shown when a ride can't be requested in time.

-- AlterTable
ALTER TABLE "TransportSettings" ADD COLUMN "shortNoticeMinutes" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN "dispatchPhone" VARCHAR(40);

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN "shortNotice" BOOLEAN NOT NULL DEFAULT false;
