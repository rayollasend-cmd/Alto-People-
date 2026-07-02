-- My Schedule wave 3: acknowledgment, reminder dedupe, shift trades,
-- one-off availability exceptions. All additive.

-- AlterTable: Shift
ALTER TABLE "Shift" ADD COLUMN "acknowledgedAt" TIMESTAMPTZ(6);
ALTER TABLE "Shift" ADD COLUMN "reminderSentAt" TIMESTAMPTZ(6);

-- AlterTable: ShiftSwapRequest (true trades)
ALTER TABLE "ShiftSwapRequest" ADD COLUMN "counterpartShiftId" UUID;
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_counterpartShiftId_fkey"
  FOREIGN KEY ("counterpartShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: AvailabilityException
CREATE TABLE "AvailabilityException" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityException_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AvailabilityException_associateId_date_key"
  ON "AvailabilityException"("associateId", "date");
CREATE INDEX "AvailabilityException_date_idx" ON "AvailabilityException"("date");

ALTER TABLE "AvailabilityException" ADD CONSTRAINT "AvailabilityException_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
