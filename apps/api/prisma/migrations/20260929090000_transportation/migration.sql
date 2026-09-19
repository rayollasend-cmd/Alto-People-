-- Transportation — the Alto vans: bookings, van runs, drivers, stops,
-- fares and ride charges, riders' issues; the Transportation Director and
-- Driver roles.

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'TRANSPORTATION_DIRECTOR';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DRIVER';

CREATE TYPE "RideDirection" AS ENUM ('TO_WORK', 'FROM_WORK');
CREATE TYPE "RideStatus" AS ENUM ('REQUESTED', 'SCHEDULED', 'BOARDED', 'COMPLETED', 'NO_SHOW', 'CANCELLED');
CREATE TYPE "RideRunStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "TransportIssueCategory" AS ENUM ('LATE_VAN', 'MISSED_PICKUP', 'CHARGE_DISPUTE', 'SAFETY', 'VEHICLE', 'CONDUCT', 'OTHER');
CREATE TYPE "TransportIssueStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

CREATE TABLE "TransportStop" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "address" VARCHAR(300) NOT NULL,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "notes" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "TransportStop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Van" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(60) NOT NULL,
    "plate" VARCHAR(20),
    "capacity" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Van_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RidePlace" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "label" VARCHAR(40) NOT NULL,
    "address" VARCHAR(300) NOT NULL,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RidePlace_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RidePlace_associateId_idx" ON "RidePlace"("associateId");
ALTER TABLE "RidePlace" ADD CONSTRAINT "RidePlace_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RideConsent" (
    "associateId" UUID NOT NULL,
    "fareCents" INTEGER NOT NULL,
    "noShowFeeCents" INTEGER NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" VARCHAR(64),
    CONSTRAINT "RideConsent_pkey" PRIMARY KEY ("associateId")
);
ALTER TABLE "RideConsent" ADD CONSTRAINT "RideConsent_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RideRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vanId" UUID NOT NULL,
    "driverUserId" UUID NOT NULL,
    "direction" "RideDirection" NOT NULL,
    "serviceDate" VARCHAR(10) NOT NULL,
    "departAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "RideRunStatus" NOT NULL DEFAULT 'PLANNED',
    "startedAt" TIMESTAMPTZ(6),
    "endedAt" TIMESTAMPTZ(6),
    "notes" VARCHAR(500),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "RideRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RideRun_serviceDate_idx" ON "RideRun"("serviceDate");
CREATE INDEX "RideRun_driverUserId_serviceDate_idx" ON "RideRun"("driverUserId", "serviceDate");
ALTER TABLE "RideRun" ADD CONSTRAINT "RideRun_vanId_fkey" FOREIGN KEY ("vanId") REFERENCES "Van"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RideRun" ADD CONSTRAINT "RideRun_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Ride" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "direction" "RideDirection" NOT NULL,
    "locationId" UUID NOT NULL,
    "stopId" UUID,
    "address" VARCHAR(300),
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "targetAt" TIMESTAMPTZ(6) NOT NULL,
    "serviceDate" VARCHAR(10) NOT NULL,
    "status" "RideStatus" NOT NULL DEFAULT 'REQUESTED',
    "shiftId" UUID,
    "note" VARCHAR(300),
    "runId" UUID,
    "pickupOrder" INTEGER,
    "pickupAt" TIMESTAMPTZ(6),
    "fareCents" INTEGER NOT NULL,
    "noShowFeeCents" INTEGER NOT NULL,
    "chargeCents" INTEGER NOT NULL DEFAULT 0,
    "waivedAt" TIMESTAMPTZ(6),
    "waivedById" UUID,
    "waiveReason" VARCHAR(300),
    "chargedRunId" UUID,
    "chargedItemId" UUID,
    "chargedAt" TIMESTAMPTZ(6),
    "boardedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "noShowAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelledById" UUID,
    "cancelReason" VARCHAR(300),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Ride_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Ride_serviceDate_status_idx" ON "Ride"("serviceDate", "status");
CREATE INDEX "Ride_associateId_targetAt_idx" ON "Ride"("associateId", "targetAt");
CREATE INDEX "Ride_runId_idx" ON "Ride"("runId");
CREATE INDEX "Ride_chargedRunId_idx" ON "Ride"("chargedRunId");
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "TransportStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RideRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TransportIssue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reportedById" UUID NOT NULL,
    "rideId" UUID,
    "runId" UUID,
    "category" "TransportIssueCategory" NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "status" "TransportIssueStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" VARCHAR(2000),
    "resolvedAt" TIMESTAMPTZ(6),
    "resolvedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "TransportIssue_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TransportIssue_status_createdAt_idx" ON "TransportIssue"("status", "createdAt");
ALTER TABLE "TransportIssue" ADD CONSTRAINT "TransportIssue_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportIssue" ADD CONSTRAINT "TransportIssue_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TransportIssue" ADD CONSTRAINT "TransportIssue_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RideRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TransportSettings" (
    "id" VARCHAR(20) NOT NULL DEFAULT 'default',
    "fareCents" INTEGER NOT NULL DEFAULT 500,
    "noShowFeeCents" INTEGER NOT NULL DEFAULT 100,
    "cutoffHours" INTEGER NOT NULL DEFAULT 10,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "TransportSettings_pkey" PRIMARY KEY ("id")
);
