-- Phase 104 — Impossible-travel detection.
--
-- When the same associate punches at two kiosks too fast for a human to
-- physically travel between them, flag the second punch for review.
-- Heuristic: >100km in <1 hour ≈ jet flight, definitely not commuting.
-- (Real planes go faster, but they don't punch into kiosks mid-air.)
--
-- The flag is captured as both a discrete enum (so the review UI knows
-- WHY a punch is pending) and a free-form anomalyDetail blob so we can
-- show "120km from prev kiosk in 12 minutes."

CREATE TYPE "KioskAnomalyKind" AS ENUM (
    'FACE_MISMATCH',
    'IMPOSSIBLE_TRAVEL',
    'GEOFENCE_NEAR_MISS'
);

ALTER TABLE "KioskPunch"
    ADD COLUMN "anomalyKind" "KioskAnomalyKind",
    ADD COLUMN "anomalyDetail" TEXT;

CREATE INDEX "KioskPunch_anomalyKind_idx"
    ON "KioskPunch"("anomalyKind")
    WHERE "anomalyKind" IS NOT NULL;
