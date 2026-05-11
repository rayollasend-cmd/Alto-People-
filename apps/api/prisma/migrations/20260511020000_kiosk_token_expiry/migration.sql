-- Kiosk device tokens expire 90 days after issue. The /kiosk/punch
-- endpoint rejects expired tokens with 401 device_token_expired; HR
-- rotates via POST /kiosk-devices/:id/rotate, which issues a new
-- token plaintext (shown once) and pushes the expiry forward.
--
-- Backfill: every existing device gets 90 days from migration time so
-- the policy applies uniformly. Pre-existing deployments don't
-- silently keep working forever just because they predate this column.

ALTER TABLE "KioskDevice"
  ADD COLUMN "tokenExpiresAt" TIMESTAMPTZ(6);

UPDATE "KioskDevice"
SET "tokenExpiresAt" = NOW() + INTERVAL '90 days'
WHERE "tokenExpiresAt" IS NULL;
