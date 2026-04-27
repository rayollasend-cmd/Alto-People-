-- Phase 101 — Face matching at kiosk punch.
--
-- Each associate's face descriptor (128-dim Float32 vector, 512 bytes raw)
-- is captured the first time they punch via kiosk. Subsequent punches
-- compare against it via Euclidean distance; mismatches are FLAGGED for
-- HR review (not rejected — too risky in low-light, with masks, etc).
--
-- The descriptor is computed in-browser via face-api.js so we never see
-- raw biometric pixels; the stored bytes are an opaque vector.

CREATE TABLE "KioskFaceReference" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "descriptor" BYTEA NOT NULL,
    "enrolledByPunchId" UUID,
    "enrolledAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "KioskFaceReference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KioskFaceReference_associateId_key"
    ON "KioskFaceReference"("associateId");

ALTER TABLE "KioskFaceReference"
    ADD CONSTRAINT "KioskFaceReference_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KioskFaceReference"
    ADD CONSTRAINT "KioskFaceReference_enrolledByPunchId_fkey"
    FOREIGN KEY ("enrolledByPunchId") REFERENCES "KioskPunch"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Per-punch face match telemetry. NULL when the kiosk didn't send a
-- descriptor (camera denied, face-api models still loading, etc.).
ALTER TABLE "KioskPunch"
    ADD COLUMN "faceDistance" DOUBLE PRECISION,
    ADD COLUMN "faceMismatch" BOOLEAN;
