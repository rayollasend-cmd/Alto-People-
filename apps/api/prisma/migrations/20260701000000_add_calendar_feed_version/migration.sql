-- Per-associate calendar-feed token revocation. Bumping the version
-- invalidates that associate's iCal URL only; existing rows default to 1,
-- which verifies against the original (pre-version) token format, so no
-- outstanding calendar subscription breaks on deploy.
ALTER TABLE "Associate" ADD COLUMN "calendarFeedVersion" INTEGER NOT NULL DEFAULT 1;
