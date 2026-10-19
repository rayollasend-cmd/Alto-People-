-- Federal withholding for 2026, completed (STATETAX).
--
-- 1. The 2026 Social Security wage base is $184,500 (SSA, 2026 COLA fact
--    sheet); the seeded row still carried 2025's $176,100.
-- 2. The W-4 facts Pub 15-T reads that weren't stored:
--      exempt / exemptTaxYear     an "Exempt" W-4 and the year it covers
--                                 (good through February 15 of the next)
--      nonresidentAlien           Pub 15-T Tables 1/2 add-on
--      pre2020Allowances          a 2019-or-earlier W-4 never replaced
--      lockIn*                    an IRS lock-in letter (Letter 2800C)

UPDATE "payroll_config" SET "ssWageBase" = 184500 WHERE "year" = 2026 AND "ssWageBase" = 176100;

ALTER TABLE "W4Submission"
  ADD COLUMN "exempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "exemptTaxYear" INTEGER,
  ADD COLUMN "nonresidentAlien" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pre2020Allowances" INTEGER,
  ADD COLUMN "lockInFilingStatus" "W4FilingStatus",
  ADD COLUMN "lockInMultipleJobs" BOOLEAN,
  ADD COLUMN "lockInEffectiveDate" DATE,
  ADD COLUMN "lockInReceivedAt" TIMESTAMPTZ(6);
