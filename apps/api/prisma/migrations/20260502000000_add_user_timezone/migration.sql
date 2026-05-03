-- User timezone preference for date display in /settings, login history,
-- and (later) email templates. Nullable so existing rows are unaffected;
-- the UI falls back to the browser locale when null.

ALTER TABLE "User" ADD COLUMN "timezone" VARCHAR(64);
