-- Data healing: time entries created with no client (manual adds / self
-- clock-ins for associates with no open assignment) get attributed from
-- the associate's most recent APPROVED application — the same fallback
-- the resolver now applies at creation time. Entries whose associate has
-- no approved application stay untouched.
UPDATE "TimeEntry" te
SET "clientId" = app."clientId"
FROM (
  SELECT DISTINCT ON ("associateId") "associateId", "clientId"
  FROM "Application"
  WHERE "status" = 'APPROVED' AND "deletedAt" IS NULL
  ORDER BY "associateId", "approvedAt" DESC NULLS LAST
) app
WHERE te."clientId" IS NULL
  AND te."associateId" = app."associateId";
