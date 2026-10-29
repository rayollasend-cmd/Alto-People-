-- Deep audit 2026-10-29 (builder PAY): the pay-period cut and claim-then-act disbursement.
--
-- 1. PayrollRun."timeCut" — how a run sliced punches into its period.
--    Every EXISTING run is marked 'UTC' (it was made under the old cut: UTC
--    midnights). New runs default to 'SITE_DAY' (the clock-in's day on the
--    site's clock, lib/payrollRunCut). The first site-day run after a
--    UTC-cut run carries in the one evening the UTC cut left unpaid. No
--    paycheck or amount changes here; a DRAFT run re-aggregated after the
--    deploy becomes SITE_DAY.
-- 2. PayrollRun."disburseClaimedAt" — set atomically by the one request that
--    disburses a run; null on every existing row.
-- 3. A paycheck is in at most one live bank file per account: a partial
--    unique index on AchEntry (payrollItemId, payoutMethodId) over live
--    credits. Entries of a file the partner refused outright are first marked
--    RETURNED (what the code does for a refused entry), so they don't count.
--    If live data ALREADY holds a paycheck twice in live files (the bug this
--    closes), the index is NOT created and a NOTICE names the count — the
--    migration never fails a deploy; the code-level claim still applies.

ALTER TABLE "PayrollRun" ADD COLUMN IF NOT EXISTS "timeCut" VARCHAR(12) NOT NULL DEFAULT 'UTC';
ALTER TABLE "PayrollRun" ALTER COLUMN "timeCut" SET DEFAULT 'SITE_DAY';
ALTER TABLE "PayrollRun" ADD COLUMN IF NOT EXISTS "disburseClaimedAt" TIMESTAMPTZ(6);

UPDATE "AchEntry" e
   SET "status" = 'RETURNED'
  FROM "AchFile" f
 WHERE e."achFileId" = f."id"
   AND f."status" = 'REJECTED'
   AND e."status" = 'SENT';

DO $$
DECLARE dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT "payrollItemId", COALESCE("payoutMethodId", '00000000-0000-0000-0000-000000000000'::uuid)
      FROM "AchEntry"
     WHERE "kind" = 'CREDIT' AND "payrollItemId" IS NOT NULL AND "status" IN ('SENT', 'SETTLED', 'CORRECTED')
     GROUP BY 1, 2
    HAVING count(*) > 1
  ) d;
  IF dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "AchEntry_live_paycheck_credit_key"
      ON "AchEntry" ("payrollItemId", COALESCE("payoutMethodId", '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE "kind" = 'CREDIT' AND "payrollItemId" IS NOT NULL AND "status" IN ('SENT', 'SETTLED', 'CORRECTED');
  ELSE
    RAISE NOTICE 'AchEntry_live_paycheck_credit_key not created: % paycheck/account pairs are already in two live bank files — review them on Payroll banking', dupes;
  END IF;
END $$;
