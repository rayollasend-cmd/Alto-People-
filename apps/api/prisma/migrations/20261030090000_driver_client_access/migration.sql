-- Which clients a driver picks up for. A driver asks (all clients, or the
-- ones they want), the Transportation Director approves or denies, and the
-- driver sees seat requests from approved clients only.

-- CreateEnum
CREATE TYPE "DriverAccessStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED');

-- CreateTable
CREATE TABLE "DriverClientAccess" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "driverUserId" UUID NOT NULL,
    "clientId" UUID,
    "status" "DriverAccessStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" VARCHAR(300),
    "decisionNote" VARCHAR(300),
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(6),
    "decidedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DriverClientAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverClientAccess_driverUserId_clientId_key" ON "DriverClientAccess"("driverUserId", "clientId");

-- One "all clients" row per driver: Postgres treats NULLs as distinct in a
-- unique index, so the row with no client needs its own.
CREATE UNIQUE INDEX "DriverClientAccess_driver_all_key" ON "DriverClientAccess"("driverUserId") WHERE "clientId" IS NULL;

-- CreateIndex
CREATE INDEX "DriverClientAccess_status_requestedAt_idx" ON "DriverClientAccess"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "DriverClientAccess_clientId_idx" ON "DriverClientAccess"("clientId");

-- AddForeignKey
ALTER TABLE "DriverClientAccess" ADD CONSTRAINT "DriverClientAccess_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverClientAccess" ADD CONSTRAINT "DriverClientAccess_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverClientAccess" ADD CONSTRAINT "DriverClientAccess_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Everyone driving today keeps driving for everyone. A driver with no
-- approved client sees no seat requests, so without this the morning after
-- the deploy nobody would. New drivers start with nothing and ask.
INSERT INTO "DriverClientAccess" ("driverUserId", "clientId", "status", "note", "requestedAt", "decidedAt", "decisionNote", "updatedAt")
SELECT u."id", NULL, 'APPROVED', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'Driving before client access existed', CURRENT_TIMESTAMP
FROM "User" u
WHERE u."deletedAt" IS NULL
  AND (u."role" = 'DRIVER'::"Role" OR 'DRIVER'::"Role" = ANY(u."additionalRoles"));
