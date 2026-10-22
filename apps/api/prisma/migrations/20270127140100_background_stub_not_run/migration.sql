-- 2026-10-21 system audit, Tier 1 #3: the self-serve consent wrote
-- provider 'stub', status PASSED from a typed name — no check ever ran.
-- Those rows are corrected to what is true. (Separate from the migration
-- that adds NOT_RUN: a new enum value cannot be used in the transaction
-- that adds it.)
UPDATE "BackgroundCheck"
SET "status" = 'NOT_RUN',
    "provider" = 'none',
    "rawStatus" = 'NOT_RUN',
    "lastError" = 'background check not run: provider not configured',
    "completedAt" = NULL
WHERE "provider" = 'stub' AND "status" = 'PASSED';
