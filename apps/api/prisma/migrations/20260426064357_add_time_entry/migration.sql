-- CreateEnum
CREATE TYPE "TimeEntryStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "clientId" UUID,
    "clockInAt" TIMESTAMPTZ(6) NOT NULL,
    "clockOutAt" TIMESTAMPTZ(6),
    "status" "TimeEntryStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "rejectionReason" TEXT,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeEntry_associateId_clockInAt_idx" ON "TimeEntry"("associateId", "clockInAt");

-- CreateIndex
CREATE INDEX "TimeEntry_clientId_status_idx" ON "TimeEntry"("clientId", "status");

-- CreateIndex
CREATE INDEX "TimeEntry_status_idx" ON "TimeEntry"("status");

-- Partial unique: at most one ACTIVE (open) entry per associate. Enforced
-- in the DB so a concurrent double clock-in is rejected even if the route
-- guard slips. Prisma's @@unique cannot express partial indexes, so this
-- lives only in the migration.
CREATE UNIQUE INDEX "TimeEntry_associateId_active_unique"
  ON "TimeEntry"("associateId")
  WHERE status = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
