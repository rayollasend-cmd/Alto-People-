-- Tier-1 — state new-hire directory reporting stamp.
ALTER TABLE "Associate" ADD COLUMN "newHireReportedAt" TIMESTAMPTZ(6);
