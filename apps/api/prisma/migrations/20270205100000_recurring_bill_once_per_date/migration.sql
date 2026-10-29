-- Deep audit 2026-10-29 CODE-23: a recurring bill's template makes one bill per date.
-- The books sweep checked for the bill and then created it; two overlapping runs could
-- each create it. The unique key makes the second insert fail (the sweep treats that as
-- "already made").
--
-- DATA: if any template already has two bills on one date, the oldest keeps the link and
-- the others are detached from the template (recurringId set to NULL). No bill, line,
-- payment or ledger entry is deleted or changed otherwise — a detached duplicate stays a
-- bill to void or pay as it is. (alto_dev had none on 2026-10-29.)
UPDATE "Bill" b
SET "recurringId" = NULL
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "recurringId", "billDate" ORDER BY "createdAt", id) AS n
  FROM "Bill"
  WHERE "recurringId" IS NOT NULL
) d
WHERE b.id = d.id AND d.n > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "Bill_recurringId_billDate_key" ON "Bill"("recurringId", "billDate");
