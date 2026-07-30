-- Close the uniqueness gap on org-wide timesheet filings.
--
-- TimesheetFiling has @@unique([weekStart, clientId]) — but clientId is
-- nullable, and Postgres treats NULLs as distinct, so the org-wide filing
-- (clientId IS NULL) was never actually constrained. Combined with the
-- unguarded findFirst->create in fileTimesheetWeek, two admins filing the
-- same week concurrently could both create, and every later read picked an
-- arbitrary row to compute drift against.
--
-- Dedupe first (keep the most recent filedAt per week), then add a partial
-- unique index covering exactly the NULL case. A partial index rather than
-- NULLS NOT DISTINCT so this runs on any Postgres version — the same
-- hand-managed pattern TimeEntry already uses for its one-ACTIVE-per-
-- associate rule. Client-scoped rows stay covered by the existing
-- compound unique.

-- Dedupe: delete older duplicates of any (weekStart, NULL) group.
DELETE FROM "TimesheetFiling" t
USING "TimesheetFiling" newer
WHERE t."clientId" IS NULL
  AND newer."clientId" IS NULL
  AND t."weekStart" = newer."weekStart"
  AND (newer."filedAt" > t."filedAt"
       OR (newer."filedAt" = t."filedAt" AND newer."id" > t."id"));

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetFiling_weekStart_null_client_key"
  ON "TimesheetFiling"("weekStart")
  WHERE "clientId" IS NULL;
