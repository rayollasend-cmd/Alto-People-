-- Kiosk fleet notices: dedup state for the admin email warnings about
-- expiring device tokens (14-day / 3-day) and devices gone silent.
ALTER TABLE "KioskDevice" ADD COLUMN "expiryNoticeStage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KioskDevice" ADD COLUMN "silentNoticeAt" TIMESTAMPTZ;
