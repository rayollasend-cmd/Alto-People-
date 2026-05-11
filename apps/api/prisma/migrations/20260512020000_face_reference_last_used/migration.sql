-- Face descriptors live forever today; selfies age out at 90 days but
-- the underlying biometric template never expires. For associates who
-- separate, the offboarding hook nukes their descriptor — but dormant
-- associates (long unpaid leave, seasonal break, never returned) keep
-- a biometric template on file indefinitely.
--
-- lastUsedAt is stamped by /kiosk/punch on every successful face
-- match. The hourly maintenance cron sweeps references whose
-- lastUsedAt (falling back to enrolledAt for never-matched rows) is
-- more than 365 days old.

ALTER TABLE "KioskFaceReference"
  ADD COLUMN "lastUsedAt" TIMESTAMPTZ(6);
