-- Kiosk face-verification governance.
--  1. Biometric consent on the associate (BIPA-style laws require
--     affirmative consent before collecting face geometry). NULL =
--     never asked; the kiosk shows a one-time consent screen.
--  2. FACE_ENROLLMENT anomaly kind: first-enrollment punches land in
--     the review queue so an admin confirms the reference template
--     actually belongs to the associate (trust-on-first-use guard).
CREATE TYPE "FaceConsentStatus" AS ENUM ('GRANTED', 'DECLINED');
ALTER TABLE "Associate" ADD COLUMN "faceConsentStatus" "FaceConsentStatus";
ALTER TABLE "Associate" ADD COLUMN "faceConsentAt" TIMESTAMPTZ;
ALTER TYPE "KioskAnomalyKind" ADD VALUE 'FACE_ENROLLMENT';
