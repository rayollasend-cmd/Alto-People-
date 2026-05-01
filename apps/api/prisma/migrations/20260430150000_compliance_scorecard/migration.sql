-- Compliance Scorecard v1 — Walmart Contract Compliance dashboard.
-- Three purely additive concerns:
--   1. DocumentKind enum values for HR-uploaded result PDFs. These also
--      live on the feat/hr-result-uploads branch; using IF NOT EXISTS so
--      either branch can land first.
--   2. Course.complianceTag → lets the training-completeness tile count
--      completions per regulatory category without scanning free-text titles.
--   3. I9Verification.eVerify* → captures the federal E-Verify outcome HR
--      records after submitting Section 2 docs through the USCIS portal.

ALTER TYPE "DocumentKind" ADD VALUE IF NOT EXISTS 'BACKGROUND_CHECK_RESULT';
ALTER TYPE "DocumentKind" ADD VALUE IF NOT EXISTS 'DRUG_TEST_RESULT';
ALTER TYPE "DocumentKind" ADD VALUE IF NOT EXISTS 'I9_VERIFICATION_RESULT';

CREATE TYPE "ComplianceTag" AS ENUM (
  'EEO_HARASSMENT',
  'OSHA_SAFETY',
  'WALMART_CADE',
  'FOOD_HANDLER'
);

CREATE TYPE "EVerifyStatus" AS ENUM (
  'PENDING',
  'EMPLOYMENT_AUTHORIZED',
  'TENTATIVE_NONCONFIRMATION',
  'FINAL_NONCONFIRMATION',
  'CLOSE_CASE_AND_RESUBMIT'
);

ALTER TABLE "Course" ADD COLUMN "complianceTag" "ComplianceTag";

ALTER TABLE "I9Verification" ADD COLUMN "eVerifyCaseNumber" TEXT;
ALTER TABLE "I9Verification" ADD COLUMN "eVerifyStatus" "EVerifyStatus";
ALTER TABLE "I9Verification" ADD COLUMN "eVerifyClosedAt" TIMESTAMPTZ(6);
