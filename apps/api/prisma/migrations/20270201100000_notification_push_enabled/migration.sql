-- Settings › Notifications gets a Push column. Until now push had no switch
-- of its own: every sender gated it on emailEnabled, so a person could not
-- keep the email and silence the lock screen (or the other way round). And a
-- muted bell silenced that category's email and push too (notifyUser and the
-- admin fan-outs dropped the person), which three independent switches no
-- longer do.
--
-- The column defaults to true for anyone without a row. For people who had
-- already chosen silence, the switches start where their phone and inbox
-- already were, so nobody starts getting pushes or emails they had turned
-- off by deploying this:
--   push  = what they got before: on only if email was on and the bell was on
--   email = off where the bell was off (the bell used to silence it)
-- isPushMuted (lib/webPush) reads pushEnabled inside sendPushToUser;
-- mandatory categories ignore all three switches.
ALTER TABLE "NotificationPreference"
  ADD COLUMN IF NOT EXISTS "pushEnabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "NotificationPreference"
   SET "pushEnabled" = false
 WHERE "emailEnabled" = false OR "inAppEnabled" = false;

UPDATE "NotificationPreference"
   SET "emailEnabled" = false
 WHERE "inAppEnabled" = false AND "emailEnabled" = true;
