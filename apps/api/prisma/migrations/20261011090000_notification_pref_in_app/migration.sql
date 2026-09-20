-- Muting a notification category stopped the email but never the bell:
-- NotificationPreference carried only emailEnabled, so the in-app row was
-- written regardless of what Settings said. This is the missing half.
--
-- Defaults to true so every existing row keeps delivering exactly as it
-- does today; a mute only takes effect once somebody turns it off.
ALTER TABLE "NotificationPreference"
  ADD COLUMN IF NOT EXISTS "inAppEnabled" BOOLEAN NOT NULL DEFAULT true;
