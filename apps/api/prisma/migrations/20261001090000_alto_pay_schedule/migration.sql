-- Alto's pay rule, on every pay schedule (owner, 2026-09-18): biweekly —
-- two Saturday→Friday weeks — paid the Friday after the period ends.
-- Periods are counted from a Saturday that starts one (Sat Sep 12, 2026:
-- Sep 12–25 is paid Fri Oct 2; Sep 26–Oct 9 is paid Fri Oct 16).
--
-- The live schedule had been saved with a Wednesday as the period start,
-- which showed associates a Wednesday payday. Schedules are data, so the
-- code fix alone couldn't reach it.

UPDATE "PayrollSchedule"
SET "frequency" = 'BIWEEKLY',
    "anchorDate" = DATE '2026-09-12',
    "payDateOffsetDays" = 7,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "isActive" = true
  AND "deletedAt" IS NULL;

-- No company-wide schedule at all: create the one Alto runs on.
INSERT INTO "PayrollSchedule" ("id", "clientId", "name", "frequency", "anchorDate", "payDateOffsetDays", "isActive", "notes", "createdAt", "updatedAt")
SELECT gen_random_uuid(), NULL, 'Biweekly · Sat–Fri · paid the Friday after', 'BIWEEKLY', DATE '2026-09-12', 7, true,
       'Alto''s pay rule: two Saturday→Friday weeks, paid the Friday after the period ends.',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "PayrollSchedule" WHERE "clientId" IS NULL AND "isActive" = true AND "deletedAt" IS NULL
);
