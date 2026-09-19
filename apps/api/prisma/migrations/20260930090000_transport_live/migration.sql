-- Transportation phase 2: the van live on the map.

-- The van right now (the driver's phone), and the one late alert per run.
ALTER TABLE "RideRun"
  ADD COLUMN "lastLat" DECIMAL(9,6),
  ADD COLUMN "lastLng" DECIMAL(9,6),
  ADD COLUMN "lastHeading" INTEGER,
  ADD COLUMN "lastSpeedMps" DOUBLE PRECISION,
  ADD COLUMN "lastAccuracyM" INTEGER,
  ADD COLUMN "lastLocationAt" TIMESTAMPTZ(6),
  ADD COLUMN "lateAlertedAt" TIMESTAMPTZ(6);

-- "Your van is about 10 minutes away", once per ride.
ALTER TABLE "Ride" ADD COLUMN "nearNotifiedAt" TIMESTAMPTZ(6);

-- The van's trail (kept 30 days).
CREATE TABLE "RideRunPing" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "runId" UUID NOT NULL,
    "lat" DECIMAL(9,6) NOT NULL,
    "lng" DECIMAL(9,6) NOT NULL,
    "heading" INTEGER,
    "speedMps" DOUBLE PRECISION,
    "accuracyM" INTEGER,
    "at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RideRunPing_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RideRunPing_runId_at_idx" ON "RideRunPing"("runId", "at");
CREATE INDEX "RideRunPing_at_idx" ON "RideRunPing"("at");
ALTER TABLE "RideRunPing" ADD CONSTRAINT "RideRunPing_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "RideRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Address → coordinates, looked up once.
CREATE TABLE "GeoCache" (
    "key" VARCHAR(300) NOT NULL,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "found" BOOLEAN NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GeoCache_pkey" PRIMARY KEY ("key")
);
