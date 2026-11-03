-- Calm notifications (owner, 2026-11-02): one notice used to go out on every
-- channel at once, around the clock — 27,059 emails in 30 days for 250 people.
-- New delivery modes, role defaults for anyone who never chose, and held
-- emails that remember their bell copy.
ALTER TYPE "DeliveryMode" ADD VALUE IF NOT EXISTS 'IMPORTANT';
ALTER TYPE "DeliveryMode" ADD VALUE IF NOT EXISTS 'DAILY';
ALTER TYPE "DeliveryMode" ADD VALUE IF NOT EXISTS 'OFF';

ALTER TABLE "User" ADD COLUMN "deliveryPrefsSetAt" TIMESTAMPTZ(6);
-- The few who already chose something keep their choice; everyone else
-- gets the new defaults.
UPDATE "User" SET "deliveryPrefsSetAt" = now()
 WHERE "quietHoursStart" IS NOT NULL
    OR "deliveryEmail" <> 'REALTIME' OR "deliveryPush" <> 'REALTIME' OR "deliverySms" <> 'REALTIME';

ALTER TABLE "DeferredNotification"
  ADD COLUMN "notificationId" UUID,
  ADD COLUMN "html" TEXT,
  ADD COLUMN "text" TEXT;
