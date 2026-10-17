-- Driver safety training as a credential beside the licence and DOT card:
-- when its renewal date is on file, a lapse keeps the driver off runs.
ALTER TABLE "DriverProfile"
  ADD COLUMN "trainingCompletedAt" DATE,
  ADD COLUMN "trainingExpiresAt"   DATE;
