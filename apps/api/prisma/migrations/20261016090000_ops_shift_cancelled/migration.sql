-- A store-shift SOP that was opened by mistake.
--
-- An afternoon supervisor clocks in and picks the morning SOP. Until now
-- the only exits were CLOSED — which files a wrong record and counts as a
-- completed shift — or leaving it ACTIVE, which holds their clock-out
-- hostage. Neither is HR's actual intent, which is "this one never
-- happened, open the right one".
--
-- CANCELLED is that third exit. sopBlockingClockOut only looks for
-- ACTIVE, so cancelling lifts the clock-out gate; occurrenceSops excludes
-- CANCELLED, so the correct SOP can still be opened for the same
-- occurrence afterwards.
ALTER TYPE "OpsShiftStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- Why it was voided, and by whom. On the row rather than only in the
-- audit log so the record can say for itself why it does not count.
ALTER TABLE "OpsShift" ADD COLUMN IF NOT EXISTS "cancelledReason" VARCHAR(500);
ALTER TABLE "OpsShift" ADD COLUMN IF NOT EXISTS "cancelledById" UUID;

-- ADD CONSTRAINT has no IF NOT EXISTS, so guard it the long way.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OpsShift_cancelledById_fkey'
  ) THEN
    ALTER TABLE "OpsShift"
      ADD CONSTRAINT "OpsShift_cancelledById_fkey"
      FOREIGN KEY ("cancelledById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
