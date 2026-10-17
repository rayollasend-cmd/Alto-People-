-- Transportation: the driver and fleet pack.
--
--   Van              the fleet record (VIN, registration, insurance,
--                    inspection, odometer, out of service)
--   VanServiceEntry  the service log — fuel, maintenance, what it cost
--   PreTripCheck     the driver's walk around the van before a run leaves
--   TransportIncident an accident or incident, written up structured
--   RideFeedback     a rider's thumb on a finished ride
--   RideSeries       a rider's standing booking, generated ahead
--   DriverProfile    licence, DOT card, MVR, and the driver's navigation app
--   RideRun          safety stamps (stall / drift / SOS) and the driver shift
--   TransportSettings hours of service, pre-trip switch, the yard

-- Enums -------------------------------------------------------------------
CREATE TYPE "VanServiceKind" AS ENUM ('FUEL', 'OIL_CHANGE', 'TIRES', 'BRAKES', 'INSPECTION', 'REPAIR', 'CLEANING', 'OTHER');
CREATE TYPE "TransportIncidentKind" AS ENUM ('COLLISION', 'INJURY', 'BREAKDOWN', 'NEAR_MISS', 'PROPERTY_DAMAGE', 'OTHER');
CREATE TYPE "TransportIncidentStatus" AS ENUM ('OPEN', 'REVIEWED', 'CLOSED');
CREATE TYPE "NavApp" AS ENUM ('GOOGLE', 'APPLE', 'WAZE');

-- Van: the fleet record ----------------------------------------------------
ALTER TABLE "Van"
  ADD COLUMN "vin" VARCHAR(17),
  ADD COLUMN "registrationExpiresAt" DATE,
  ADD COLUMN "insuranceExpiresAt" DATE,
  ADD COLUMN "inspectionDueAt" DATE,
  ADD COLUMN "odometerMiles" INTEGER,
  ADD COLUMN "outOfServiceAt" TIMESTAMPTZ(6),
  ADD COLUMN "outOfServiceReason" VARCHAR(300);

-- Ride: the series it came from, and the drop-off word -----------------------
ALTER TABLE "Ride"
  ADD COLUMN "seriesId" UUID,
  ADD COLUMN "droppedNotifiedAt" TIMESTAMPTZ(6);
CREATE INDEX "Ride_seriesId_idx" ON "Ride"("seriesId");

-- RideRun: safety stamps and the driver shift ---------------------------------
ALTER TABLE "RideRun"
  ADD COLUMN "stallAlertedAt" TIMESTAMPTZ(6),
  ADD COLUMN "stallEscalatedAt" TIMESTAMPTZ(6),
  ADD COLUMN "driverOkAt" TIMESTAMPTZ(6),
  ADD COLUMN "minDistToNextM" INTEGER,
  ADD COLUMN "sosAt" TIMESTAMPTZ(6),
  ADD COLUMN "sosNote" VARCHAR(300),
  ADD COLUMN "sosAckAt" TIMESTAMPTZ(6),
  ADD COLUMN "sosAckById" UUID,
  ADD COLUMN "shiftId" UUID;

-- TransportSettings: hours of service, the pre-trip switch, the yard ----------
ALTER TABLE "TransportSettings"
  ADD COLUMN "driverMaxHoursPerDay" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "driverMinRestHours" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN "preTripRequired" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "driverShiftLocationId" UUID;

-- VanServiceEntry -----------------------------------------------------------
CREATE TABLE "VanServiceEntry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "vanId" UUID NOT NULL,
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "kind" "VanServiceKind" NOT NULL,
  "occurredAt" DATE NOT NULL,
  "odometerMiles" INTEGER,
  "costCents" INTEGER NOT NULL DEFAULT 0,
  "vendor" VARCHAR(120),
  "notes" VARCHAR(500),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VanServiceEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VanServiceEntry_vanId_occurredAt_idx" ON "VanServiceEntry"("vanId", "occurredAt");
CREATE INDEX "VanServiceEntry_tenantId_idx" ON "VanServiceEntry"("tenantId");
ALTER TABLE "VanServiceEntry" ADD CONSTRAINT "VanServiceEntry_vanId_fkey"
  FOREIGN KEY ("vanId") REFERENCES "Van"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PreTripCheck --------------------------------------------------------------
CREATE TABLE "PreTripCheck" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "runId" UUID NOT NULL,
  "vanId" UUID NOT NULL,
  "driverUserId" UUID NOT NULL,
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "items" JSONB NOT NULL,
  "passed" BOOLEAN NOT NULL,
  "odometerMiles" INTEGER,
  "photoS3Key" VARCHAR(300),
  "notes" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreTripCheck_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PreTripCheck_runId_key" ON "PreTripCheck"("runId");
CREATE INDEX "PreTripCheck_vanId_createdAt_idx" ON "PreTripCheck"("vanId", "createdAt");
CREATE INDEX "PreTripCheck_tenantId_idx" ON "PreTripCheck"("tenantId");
ALTER TABLE "PreTripCheck" ADD CONSTRAINT "PreTripCheck_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "RideRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreTripCheck" ADD CONSTRAINT "PreTripCheck_vanId_fkey"
  FOREIGN KEY ("vanId") REFERENCES "Van"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreTripCheck" ADD CONSTRAINT "PreTripCheck_driverUserId_fkey"
  FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- TransportIncident ---------------------------------------------------------
CREATE TABLE "TransportIncident" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "kind" "TransportIncidentKind" NOT NULL,
  "status" "TransportIncidentStatus" NOT NULL DEFAULT 'OPEN',
  "runId" UUID,
  "vanId" UUID,
  "reportedById" UUID NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "lat" DECIMAL(9,6),
  "lng" DECIMAL(9,6),
  "description" VARCHAR(4000) NOT NULL,
  "injuries" BOOLEAN NOT NULL DEFAULT false,
  "injuredAssociateIds" JSONB NOT NULL DEFAULT '[]',
  "parties" JSONB NOT NULL DEFAULT '[]',
  "policeReportNumber" VARCHAR(60),
  "photoKeys" JSONB NOT NULL DEFAULT '[]',
  "oshaIncidentIds" JSONB NOT NULL DEFAULT '[]',
  "vanParked" BOOLEAN NOT NULL DEFAULT false,
  "reviewNote" VARCHAR(2000),
  "reviewedAt" TIMESTAMPTZ(6),
  "reviewedById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TransportIncident_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TransportIncident_status_occurredAt_idx" ON "TransportIncident"("status", "occurredAt");
CREATE INDEX "TransportIncident_vanId_idx" ON "TransportIncident"("vanId");
CREATE INDEX "TransportIncident_tenantId_idx" ON "TransportIncident"("tenantId");
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "RideRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_vanId_fkey"
  FOREIGN KEY ("vanId") REFERENCES "Van"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_reportedById_fkey"
  FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RideFeedback --------------------------------------------------------------
CREATE TABLE "RideFeedback" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "rideId" UUID NOT NULL,
  "associateId" UUID NOT NULL,
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "thumbsUp" BOOLEAN NOT NULL,
  "reason" VARCHAR(20),
  "note" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RideFeedback_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RideFeedback_rideId_key" ON "RideFeedback"("rideId");
CREATE INDEX "RideFeedback_createdAt_idx" ON "RideFeedback"("createdAt");
CREATE INDEX "RideFeedback_tenantId_idx" ON "RideFeedback"("tenantId");
ALTER TABLE "RideFeedback" ADD CONSTRAINT "RideFeedback_rideId_fkey"
  FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RideFeedback" ADD CONSTRAINT "RideFeedback_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RideSeries ----------------------------------------------------------------
CREATE TABLE "RideSeries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "associateId" UUID NOT NULL,
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "direction" "RideDirection" NOT NULL,
  "locationId" UUID NOT NULL,
  "stopId" UUID,
  "address" VARCHAR(300),
  "lat" DECIMAL(9,6),
  "lng" DECIMAL(9,6),
  "windowLabel" VARCHAR(80),
  "timeOfDay" VARCHAR(5),
  "daysOfWeek" INTEGER[],
  "startsOn" DATE NOT NULL,
  "endsOn" DATE,
  "note" VARCHAR(300),
  "generatedThrough" DATE,
  "cancelledAt" TIMESTAMPTZ(6),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "RideSeries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RideSeries_associateId_cancelledAt_idx" ON "RideSeries"("associateId", "cancelledAt");
CREATE INDEX "RideSeries_tenantId_idx" ON "RideSeries"("tenantId");
ALTER TABLE "RideSeries" ADD CONSTRAINT "RideSeries_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RideSeries" ADD CONSTRAINT "RideSeries_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_seriesId_fkey"
  FOREIGN KEY ("seriesId") REFERENCES "RideSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DriverProfile -------------------------------------------------------------
CREATE TABLE "DriverProfile" (
  "userId" UUID NOT NULL,
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "navApp" "NavApp" NOT NULL DEFAULT 'GOOGLE',
  "licenceNumber" VARCHAR(40),
  "licenceState" VARCHAR(2),
  "licenceClass" VARCHAR(10),
  "licenceExpiresAt" DATE,
  "dotMedicalRequired" BOOLEAN NOT NULL DEFAULT false,
  "dotMedicalExpiresAt" DATE,
  "mvrCheckedAt" DATE,
  "notes" VARCHAR(500),
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "DriverProfile_pkey" PRIMARY KEY ("userId")
);
CREATE INDEX "DriverProfile_tenantId_idx" ON "DriverProfile"("tenantId");
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
