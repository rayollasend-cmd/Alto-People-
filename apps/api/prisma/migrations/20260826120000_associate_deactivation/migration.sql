-- Manual pause ("Deactivate" on the People profile) — distinct from a
-- completed Separation. Reactivate clears all three columns.
ALTER TABLE "Associate"
  ADD COLUMN "deactivatedAt" TIMESTAMPTZ(6),
  ADD COLUMN "deactivatedById" UUID,
  ADD COLUMN "deactivationReason" TEXT;

ALTER TABLE "Associate"
  ADD CONSTRAINT "Associate_deactivatedById_fkey"
  FOREIGN KEY ("deactivatedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
