-- Location.timezone: IANA name of the physical work site. Turns a shift's
-- UTC instant into store wall-clock time for availability matching, the
-- schedule PDF, and shift notifications. Defaults to Eastern (current
-- deployment); existing rows backfill to the same default.
ALTER TABLE "Location" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/New_York';
