-- Phase: Onboarding approve / reject (HR review outcome).
--
-- Adds the columns the new POST /onboarding/applications/:id/approve and
-- /reject routes write to. All purely additive (nullable timestamps + a
-- nullable text column + a date on Associate) so existing rows continue
-- to read fine.

ALTER TABLE "Application"
  ADD COLUMN "approvedAt" TIMESTAMPTZ(6),
  ADD COLUMN "rejectedAt" TIMESTAMPTZ(6),
  ADD COLUMN "rejectionReason" TEXT;

ALTER TABLE "Associate"
  ADD COLUMN "hireDate" DATE;
