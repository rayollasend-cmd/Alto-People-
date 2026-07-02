-- Punch↔shift link: tie a time entry to the scheduled shift it fulfills.
-- Matched automatically at clock-in (kiosk + web); NULL for unscheduled
-- punches and for every entry that pre-dates this column.

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "shiftId" UUID;

-- CreateIndex
CREATE INDEX "TimeEntry_shiftId_idx" ON "TimeEntry"("shiftId");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
