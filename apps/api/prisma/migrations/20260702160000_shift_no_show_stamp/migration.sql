-- No-show alert dedupe stamp: the sweep claims a shift whose start passed
-- with no linked punch by setting this before notifying admins.

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "noShowNotifiedAt" TIMESTAMPTZ(6);
