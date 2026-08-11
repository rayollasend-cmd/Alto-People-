-- Separation completion now actually deactivates the associate. The
-- directory derived "Active" purely from "has an APPROVED application",
-- so people who stopped working stayed Active forever — and their login
-- was never disabled despite the completion notice claiming "access
-- revoked".
ALTER TABLE "Associate" ADD COLUMN "separatedAt" TIMESTAMPTZ(6);

-- Backfill from already-completed separations (latest per associate).
-- Rehires are safe: the directory treats a separation as superseded when
-- a NEWER application approval exists.
UPDATE "Associate" a
SET "separatedAt" = s."completedAt"
FROM (
  SELECT DISTINCT ON ("associateId") "associateId", "completedAt"
  FROM "Separation"
  WHERE "status" = 'COMPLETE' AND "completedAt" IS NOT NULL
  ORDER BY "associateId", "completedAt" DESC
) s
WHERE s."associateId" = a."id" AND a."separatedAt" IS NULL;
