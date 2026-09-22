-- File every Store Ops shift under the building it ran in.
--
-- OpsShift has carried a locationId since store-shift SOPs shipped, but
-- only the clock-in path ever set it: a shift opened by hand had no store
-- at all. So the board could not say which building a shift ran in, and
-- "what happened on the overnight at Destin" had no record to find — the
-- rows exist, they were just filed under the client.
--
-- Backfilled by the same rules the open path now uses, in order.

-- 1. The supervisor's own store, when they have one and it belongs to
--    the client the shift was opened for.
UPDATE "OpsShift" o
   SET "locationId" = u."locationId"
  FROM "User" u
  JOIN "Location" l ON l.id = u."locationId"
 WHERE o."locationId" IS NULL
   AND u.id = o."openedById"
   AND l."clientId" = o."clientId";

-- 2. A client with one active building can only mean that one.
UPDATE "OpsShift" o
   SET "locationId" = sole.id
  FROM (
    SELECT "clientId", MIN(id::text)::uuid AS id
      FROM "Location"
     WHERE "deletedAt" IS NULL AND "isActive" = true
     GROUP BY "clientId"
    HAVING COUNT(*) = 1
  ) sole
 WHERE o."locationId" IS NULL
   AND sole."clientId" = o."clientId";

-- The board reads by store and by day, and the history view reads by
-- store across a range.
CREATE INDEX IF NOT EXISTS "OpsShift_locationId_dateKey_idx"
  ON "OpsShift"("locationId", "dateKey");
-- Closed shifts are listed by WHEN THEY CLOSED, not by the day they
-- opened — an overnight closes on the following date, which is why it
-- used to disappear from the board the moment it ended.
CREATE INDEX IF NOT EXISTS "OpsShift_closedAt_idx"
  ON "OpsShift"("closedAt" DESC);
