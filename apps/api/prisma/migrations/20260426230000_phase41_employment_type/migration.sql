-- Phase 41 — employment type on Associate (W-2 vs 1099).
-- Adds enum + nullable-default column. All existing rows default to
-- W2_EMPLOYEE so payroll math stays identical for them; 1099 contractors
-- get this set explicitly when HR creates the application.

CREATE TYPE "EmploymentType" AS ENUM (
  'W2_EMPLOYEE',
  'CONTRACTOR_1099_INDIVIDUAL',
  'CONTRACTOR_1099_BUSINESS'
);

ALTER TABLE "Associate"
  ADD COLUMN "employmentType" "EmploymentType" NOT NULL DEFAULT 'W2_EMPLOYEE';
