-- Brief 1A-4: users & access cleanup. Additive only.
--
-- A deactivation is reversible for 30 days: the account is DISABLED with
-- the reason and who did it, and purgeAfter names the day the sweep
-- soft-deletes it (deletedAt). Nothing is ever hard-deleted here.
-- Region scope on a portal account needs a named approver, recorded on the
-- account as well as in the audit log.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "deactivationReason" VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "deactivatedById" UUID,
  ADD COLUMN IF NOT EXISTS "purgeAfter" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "regionApprovedById" UUID,
  ADD COLUMN IF NOT EXISTS "regionApprovedAt" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "User_purgeAfter_idx" ON "User"("purgeAfter");
