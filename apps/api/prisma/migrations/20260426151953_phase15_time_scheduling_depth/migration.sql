-- CreateEnum
CREATE TYPE "BreakType" AS ENUM ('MEAL', 'REST');

-- CreateEnum
CREATE TYPE "ShiftSwapStatus" AS ENUM ('PENDING_PEER', 'PEER_ACCEPTED', 'PEER_DECLINED', 'MANAGER_APPROVED', 'MANAGER_REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "geofenceRadiusMeters" INTEGER,
ADD COLUMN     "latitude" DECIMAL(10,7),
ADD COLUMN     "longitude" DECIMAL(10,7);

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "payRate" DECIMAL(8,2);

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "anomalies" JSONB,
ADD COLUMN     "clockInLat" DECIMAL(10,7),
ADD COLUMN     "clockInLng" DECIMAL(10,7),
ADD COLUMN     "clockOutLat" DECIMAL(10,7),
ADD COLUMN     "clockOutLng" DECIMAL(10,7),
ADD COLUMN     "jobId" UUID,
ADD COLUMN     "payRate" DECIMAL(8,2);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "billRate" DECIMAL(8,2),
    "payRate" DECIMAL(8,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timeEntryId" UUID NOT NULL,
    "type" "BreakType" NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "endedAt" TIMESTAMPTZ(6),

    CONSTRAINT "BreakEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssociateAvailability" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AssociateAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSwapRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shiftId" UUID NOT NULL,
    "requesterAssociateId" UUID NOT NULL,
    "counterpartyAssociateId" UUID NOT NULL,
    "status" "ShiftSwapStatus" NOT NULL DEFAULT 'PENDING_PEER',
    "note" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ShiftSwapRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_clientId_isActive_idx" ON "Job"("clientId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Job_clientId_name_key" ON "Job"("clientId", "name");

-- CreateIndex
CREATE INDEX "BreakEntry_timeEntryId_idx" ON "BreakEntry"("timeEntryId");

-- CreateIndex
CREATE INDEX "AssociateAvailability_associateId_dayOfWeek_idx" ON "AssociateAvailability"("associateId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "ShiftSwapRequest_shiftId_idx" ON "ShiftSwapRequest"("shiftId");

-- CreateIndex
CREATE INDEX "ShiftSwapRequest_counterpartyAssociateId_status_idx" ON "ShiftSwapRequest"("counterpartyAssociateId", "status");

-- CreateIndex
CREATE INDEX "ShiftSwapRequest_requesterAssociateId_status_idx" ON "ShiftSwapRequest"("requesterAssociateId", "status");

-- CreateIndex
CREATE INDEX "TimeEntry_jobId_idx" ON "TimeEntry"("jobId");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakEntry" ADD CONSTRAINT "BreakEntry_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssociateAvailability" ADD CONSTRAINT "AssociateAvailability_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_requesterAssociateId_fkey" FOREIGN KEY ("requesterAssociateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_counterpartyAssociateId_fkey" FOREIGN KEY ("counterpartyAssociateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
