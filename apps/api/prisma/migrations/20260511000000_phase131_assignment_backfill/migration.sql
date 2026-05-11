-- Phase 131 follow-up — open an AssociateAssignment row for any
-- approved associate that doesn't already have one. Idempotent:
-- already-placed associates and not-yet-approved associates are
-- skipped. On dev (zero approved applications today) this is a
-- no-op; on prod / future installs it backfills pre-Phase-131
-- approved associates so reads can rely on the open assignment as
-- the source of truth for "current work site".
--
-- Location selection priority:
--   1. Application.locationId (if HR picked one at invite or it was
--      backfilled by 20260510000000).
--   2. First active Location under the Application's clientId
--      (always present for Clients that existed at migration time,
--      since the previous migration created default Locations 1:1).
-- Rows where neither resolves are skipped — those associates can be
-- placed manually via the Transfer button.

INSERT INTO "AssociateAssignment" ("associateId", "locationId", "startedAt", "reason", "createdAt")
SELECT
  a."id"                                              AS "associateId",
  COALESCE(
    app."locationId",
    (
      SELECT l."id" FROM "Location" l
      WHERE l."clientId" = app."clientId"
        AND l."deletedAt" IS NULL
        AND l."isActive" = TRUE
      ORDER BY l."createdAt" ASC
      LIMIT 1
    )
  )                                                   AS "locationId",
  COALESCE(a."hireDate", app."approvedAt"::DATE, NOW()::DATE) AS "startedAt",
  'Phase 131 backfill'                                AS "reason",
  NOW()                                               AS "createdAt"
FROM "Associate" a
JOIN LATERAL (
  SELECT app2."locationId", app2."clientId", app2."approvedAt"
  FROM "Application" app2
  WHERE app2."associateId" = a."id"
    AND app2."status" = 'APPROVED'
    AND app2."deletedAt" IS NULL
  ORDER BY app2."invitedAt" DESC
  LIMIT 1
) app ON TRUE
WHERE a."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "AssociateAssignment" aa
    WHERE aa."associateId" = a."id" AND aa."endedAt" IS NULL
  )
  AND (
    app."locationId" IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM "Location" l
      WHERE l."clientId" = app."clientId"
        AND l."deletedAt" IS NULL
        AND l."isActive" = TRUE
    )
  );
