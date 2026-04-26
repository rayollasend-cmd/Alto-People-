-- CreateEnum
CREATE TYPE "TimeOffCategory" AS ENUM ('SICK', 'VACATION', 'PTO', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER');

-- CreateEnum
CREATE TYPE "TimeOffLedgerReason" AS ENUM ('ACCRUAL', 'USE', 'ADJUSTMENT', 'PAYOUT');

-- CreateTable
CREATE TABLE "TimeOffBalance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "category" "TimeOffCategory" NOT NULL,
    "balanceMinutes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimeOffBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeOffLedgerEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "category" "TimeOffCategory" NOT NULL,
    "reason" "TimeOffLedgerReason" NOT NULL,
    "deltaMinutes" INTEGER NOT NULL,
    "sourceTimeEntryId" UUID,
    "sourceUserId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeOffLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeOffBalance_associateId_idx" ON "TimeOffBalance"("associateId");

-- CreateIndex
CREATE UNIQUE INDEX "TimeOffBalance_associateId_category_key" ON "TimeOffBalance"("associateId", "category");

-- CreateIndex
CREATE INDEX "TimeOffLedgerEntry_associateId_createdAt_idx" ON "TimeOffLedgerEntry"("associateId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TimeOffLedgerEntry_sourceTimeEntryId_category_reason_key" ON "TimeOffLedgerEntry"("sourceTimeEntryId", "category", "reason");

-- AddForeignKey
ALTER TABLE "TimeOffBalance" ADD CONSTRAINT "TimeOffBalance_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOffLedgerEntry" ADD CONSTRAINT "TimeOffLedgerEntry_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOffLedgerEntry" ADD CONSTRAINT "TimeOffLedgerEntry_sourceTimeEntryId_fkey" FOREIGN KEY ("sourceTimeEntryId") REFERENCES "TimeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOffLedgerEntry" ADD CONSTRAINT "TimeOffLedgerEntry_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
