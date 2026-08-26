-- Onboarding purge sweep (lib/onboardingPurge.ts).

-- Distinguish reminder-sweep-minted tokens from human-caused ones so the
-- purge clock only counts the latter.
ALTER TABLE "InviteToken" ADD COLUMN "mintedBySweep" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: the 48h sweep has always stamped reminderSentAt at the same
-- instant it created the token; human paths stamped it too, but human
-- tokens are superseded/consumed quickly and mis-tagging an old consumed
-- token is harmless — the clock only reads the NEWEST non-sweep token and
-- falls back to User.createdAt.
UPDATE "InviteToken" SET "mintedBySweep" = true WHERE "reminderSentAt" = "createdAt";

-- Final-notice stamp for the abandoned-onboarding purge.
ALTER TABLE "Associate" ADD COLUMN "purgeWarnedAt" TIMESTAMPTZ(6);
