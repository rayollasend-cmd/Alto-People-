-- Docs & compliance overhaul: agreement lifecycle bookkeeping.

ALTER TABLE "Agreement" ADD COLUMN "reminderSentAt" TIMESTAMPTZ(6);
ALTER TABLE "Agreement" ADD COLUMN "deletedAt" TIMESTAMPTZ(6);
CREATE INDEX "Agreement_deletedAt_idx" ON "Agreement"("deletedAt");
