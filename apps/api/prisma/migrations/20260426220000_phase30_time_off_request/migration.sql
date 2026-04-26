-- CreateEnum
CREATE TYPE "TimeOffRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED');

-- AlterTable
ALTER TABLE "TimeOffLedgerEntry" ADD COLUMN "sourceRequestId" UUID;

-- CreateTable
CREATE TABLE "TimeOffRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "category" "TimeOffCategory" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "requestedMinutes" INTEGER NOT NULL,
    "reason" TEXT,
    "status" "TimeOffRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewerUserId" UUID,
    "reviewerNote" TEXT,
    "decidedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimeOffRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimeOffLedgerEntry_sourceRequestId_key" ON "TimeOffLedgerEntry"("sourceRequestId");

-- CreateIndex
CREATE INDEX "TimeOffRequest_associateId_status_idx" ON "TimeOffRequest"("associateId", "status");

-- CreateIndex
CREATE INDEX "TimeOffRequest_status_createdAt_idx" ON "TimeOffRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "TimeOffLedgerEntry" ADD CONSTRAINT "TimeOffLedgerEntry_sourceRequestId_fkey" FOREIGN KEY ("sourceRequestId") REFERENCES "TimeOffRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOffRequest" ADD CONSTRAINT "TimeOffRequest_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOffRequest" ADD CONSTRAINT "TimeOffRequest_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
