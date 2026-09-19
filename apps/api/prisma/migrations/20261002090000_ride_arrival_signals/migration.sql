-- The pickup handshake: the driver's "Arrived" (and the 3-minute wait
-- before a no-show), and the rider's "I'm outside" / "running late".
ALTER TABLE "Ride"
  ADD COLUMN "vanArrivedAt" TIMESTAMPTZ(6),
  ADD COLUMN "riderSignal" VARCHAR(20),
  ADD COLUMN "riderSignalAt" TIMESTAMPTZ(6);
