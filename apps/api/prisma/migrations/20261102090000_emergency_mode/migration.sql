-- Brief 1C-1: Emergency Mode. Additive only — three new tables and two
-- nullable tags on Shift and Ride. Nothing existing changes shape.

CREATE TYPE "EmergencyStatus" AS ENUM ('ACTIVE', 'STOOD_DOWN');
CREATE TYPE "EmergencyCheckInStatus" AS ENUM ('SAFE', 'NEEDS_HELP');

CREATE TABLE "Emergency" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(120) NOT NULL,
    "messageEn" VARCHAR(2000) NOT NULL,
    "messageEs" VARCHAR(2000) NOT NULL,
    "messageTr" VARCHAR(2000) NOT NULL,
    "allSites" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "pickupAt" TIMESTAMPTZ(6),
    "destinationLocationId" UUID,
    "escalationMinutes" INTEGER NOT NULL DEFAULT 60,
    "status" "EmergencyStatus" NOT NULL DEFAULT 'ACTIVE',
    "declaredById" UUID,
    "declaredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoodDownById" UUID,
    "stoodDownAt" TIMESTAMPTZ(6),
    "shiftsSuspended" INTEGER NOT NULL DEFAULT 0,
    "associatesNotified" INTEGER NOT NULL DEFAULT 0,
    "shiftsRestored" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Emergency_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Emergency_status_declaredAt_idx" ON "Emergency"("status", "declaredAt" DESC);

ALTER TABLE "Emergency" ADD CONSTRAINT "Emergency_declaredById_fkey" FOREIGN KEY ("declaredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Emergency" ADD CONSTRAINT "Emergency_stoodDownById_fkey" FOREIGN KEY ("stoodDownById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Emergency" ADD CONSTRAINT "Emergency_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "EmergencySite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "emergencyId" UUID NOT NULL,
    "locationId" UUID NOT NULL,

    CONSTRAINT "EmergencySite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmergencySite_emergencyId_locationId_key" ON "EmergencySite"("emergencyId", "locationId");
CREATE INDEX "EmergencySite_locationId_idx" ON "EmergencySite"("locationId");

ALTER TABLE "EmergencySite" ADD CONSTRAINT "EmergencySite_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "Emergency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmergencySite" ADD CONSTRAINT "EmergencySite_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EmergencyCheckIn" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "emergencyId" UUID NOT NULL,
    "associateId" UUID NOT NULL,
    "status" "EmergencyCheckInStatus" NOT NULL,
    "needsRide" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(300),
    "rideId" UUID,
    "respondedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmergencyCheckIn_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmergencyCheckIn_emergencyId_associateId_key" ON "EmergencyCheckIn"("emergencyId", "associateId");
CREATE INDEX "EmergencyCheckIn_emergencyId_status_idx" ON "EmergencyCheckIn"("emergencyId", "status");

ALTER TABLE "EmergencyCheckIn" ADD CONSTRAINT "EmergencyCheckIn_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "Emergency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmergencyCheckIn" ADD CONSTRAINT "EmergencyCheckIn_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmergencyCheckIn" ADD CONSTRAINT "EmergencyCheckIn_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Shift: suspended by which emergency, and what it was before.
ALTER TABLE "Shift" ADD COLUMN "emergencyId" UUID;
ALTER TABLE "Shift" ADD COLUMN "emergencyPriorStatus" "ShiftStatus";
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "Emergency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ride: an evacuation seat belongs to an emergency.
ALTER TABLE "Ride" ADD COLUMN "emergencyId" UUID;
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "Emergency"("id") ON DELETE SET NULL ON UPDATE CASCADE;
