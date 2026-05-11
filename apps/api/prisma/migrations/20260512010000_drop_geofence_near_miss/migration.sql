-- KioskAnomalyKind.GEOFENCE_NEAR_MISS was added in Phase 104 anticipating
-- a "you were 1-1.5× the radius out, maybe a GPS hiccup, maybe drifting"
-- flag. The classifier was never written, no production KioskPunch row
-- carries the value, and the unused enum slot is dead surface area for
-- future contributors. Drop it.
--
-- Safe to drop: SELECT 1 FROM "KioskPunch" WHERE "anomalyKind" =
-- 'GEOFENCE_NEAR_MISS' returns zero rows in dev + prod (verified before
-- ship).

ALTER TYPE "KioskAnomalyKind" RENAME TO "KioskAnomalyKind_old";

CREATE TYPE "KioskAnomalyKind" AS ENUM ('FACE_MISMATCH', 'IMPOSSIBLE_TRAVEL');

ALTER TABLE "KioskPunch"
  ALTER COLUMN "anomalyKind" TYPE "KioskAnomalyKind"
  USING ("anomalyKind"::text::"KioskAnomalyKind");

DROP TYPE "KioskAnomalyKind_old";
