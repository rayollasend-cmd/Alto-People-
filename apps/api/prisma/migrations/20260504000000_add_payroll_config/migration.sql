-- Add the payroll_config table holding IRS-yearly constants the
-- withholding engine consumes. One row per calendar year. The withholding
-- engine in lib/payrollTax.ts loads the row matching the pay-date year at
-- boot, caches it, and uses it for the life of the process. SUTA per-state
-- tables and state income brackets stay as code constants — they're not
-- federal annual updates and the org is Florida-only anyway.
--
-- This migration also seeds the 2026 row at the bottom so prod converges
-- in one step on `prisma migrate deploy`. ON CONFLICT DO NOTHING makes the
-- seed idempotent if the migration is re-run.
--
-- Source for the 2026 values: IRS Publication 15-T (2026), page 12,
-- "2026 Percentage Method Tables for Automated Payroll Systems and
--  Withholding on Periodic Payments of Pensions and Annuities" —
-- STANDARD Withholding Rate Schedules, W-4 Step 2 NOT checked.

-- CreateTable
CREATE TABLE "payroll_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "year" INTEGER NOT NULL,
    "fedBracketsSingle" JSONB NOT NULL,
    "fedBracketsMfj" JSONB NOT NULL,
    "fedBracketsHoh" JSONB NOT NULL,
    "ssWageBase" DECIMAL(12,2) NOT NULL,
    "medicareSurchargeThreshold" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payroll_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_config_year_key" ON "payroll_config"("year");

-- ---------------------------------------------------------------------------
-- 2026 reference data (IRS Pub 15-T 2026, Worksheet 1A annual percentage
-- method, Standard Withholding Rate Schedules — W-4 Step 2 NOT checked).
-- ---------------------------------------------------------------------------
INSERT INTO "payroll_config" (
    "year",
    "fedBracketsSingle",
    "fedBracketsMfj",
    "fedBracketsHoh",
    "ssWageBase",
    "medicareSurchargeThreshold",
    "updatedAt"
) VALUES (
    2026,
    -- SINGLE or Married Filing Separately — annual, standard withholding.
    '[
      {"over": 0,       "flat": 0,          "rate": 0},
      {"over": 7500,    "flat": 0,          "rate": 0.10},
      {"over": 19900,   "flat": 1240.00,    "rate": 0.12},
      {"over": 57900,   "flat": 5800.00,    "rate": 0.22},
      {"over": 113200,  "flat": 17966.00,   "rate": 0.24},
      {"over": 209275,  "flat": 41024.00,   "rate": 0.32},
      {"over": 263725,  "flat": 58448.00,   "rate": 0.35},
      {"over": 648100,  "flat": 192979.25,  "rate": 0.37}
    ]'::jsonb,
    -- MARRIED FILING JOINTLY — annual, standard withholding.
    '[
      {"over": 0,       "flat": 0,          "rate": 0},
      {"over": 19300,   "flat": 0,          "rate": 0.10},
      {"over": 44100,   "flat": 2480.00,    "rate": 0.12},
      {"over": 120100,  "flat": 11600.00,   "rate": 0.22},
      {"over": 230700,  "flat": 35932.00,   "rate": 0.24},
      {"over": 422850,  "flat": 82048.00,   "rate": 0.32},
      {"over": 531750,  "flat": 116896.00,  "rate": 0.35},
      {"over": 788000,  "flat": 206583.50,  "rate": 0.37}
    ]'::jsonb,
    -- HEAD OF HOUSEHOLD — annual, standard withholding.
    '[
      {"over": 0,       "flat": 0,          "rate": 0},
      {"over": 15550,   "flat": 0,          "rate": 0.10},
      {"over": 33250,   "flat": 1770.00,    "rate": 0.12},
      {"over": 83000,   "flat": 7740.00,    "rate": 0.22},
      {"over": 121250,  "flat": 16155.00,   "rate": 0.24},
      {"over": 217300,  "flat": 39207.00,   "rate": 0.32},
      {"over": 271750,  "flat": 56631.00,   "rate": 0.35},
      {"over": 656150,  "flat": 191171.00,  "rate": 0.37}
    ]'::jsonb,
    -- SSA wage base 2026 (was $168,600 in 2024, $176,100 in 2025–2026).
    176100.00,
    -- Additional Medicare 0.9% surcharge YTD threshold. Has held at
    -- $200,000 since 2013 (IRC §3101(b)(2)).
    200000.00,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("year") DO NOTHING;
