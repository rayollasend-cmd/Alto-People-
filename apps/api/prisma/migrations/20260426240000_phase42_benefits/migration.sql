-- Phase 42 — Benefits enrollment.
-- Plans live per-client (each Client offers its own benefits package);
-- enrollments link an Associate to a Plan with a per-pay-period elected
-- amount. PayrollItem grows a preTaxDeductions column so the engine can
-- snapshot what was deducted this period (taxable income pre-FIT/FICA/
-- Medicare drops by this amount).

CREATE TYPE "BenefitsPlanKind" AS ENUM (
  'HEALTH_MEDICAL',
  'DENTAL',
  'VISION',
  'HSA',
  'FSA_HEALTHCARE',
  'FSA_DEPENDENT_CARE',
  'RETIREMENT_401K',
  'RETIREMENT_403B',
  'LIFE_INSURANCE',
  'DISABILITY'
);

CREATE TABLE "BenefitsPlan" (
  "id"                                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"                                    UUID NOT NULL,
  "kind"                                        "BenefitsPlanKind" NOT NULL,
  "name"                                        TEXT NOT NULL,
  "description"                                 TEXT,
  "employerContributionCentsPerPeriod"          INTEGER NOT NULL DEFAULT 0,
  "employeeContributionDefaultCentsPerPeriod"   INTEGER NOT NULL DEFAULT 0,
  "isActive"                                    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"                                   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"                                   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "BenefitsPlan_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE
);

CREATE INDEX "BenefitsPlan_clientId_isActive_idx"
  ON "BenefitsPlan" ("clientId", "isActive");
CREATE INDEX "BenefitsPlan_clientId_kind_idx"
  ON "BenefitsPlan" ("clientId", "kind");

CREATE TABLE "BenefitsEnrollment" (
  "id"                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"                 UUID NOT NULL,
  "planId"                      UUID NOT NULL,
  "electedAmountCentsPerPeriod" INTEGER NOT NULL,
  "effectiveDate"               DATE NOT NULL,
  "terminationDate"             DATE,
  "createdAt"                   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"                   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "BenefitsEnrollment_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "BenefitsEnrollment_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "BenefitsPlan"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "BenefitsEnrollment_associateId_planId_effectiveDate_key"
  ON "BenefitsEnrollment" ("associateId", "planId", "effectiveDate");
CREATE INDEX "BenefitsEnrollment_associateId_terminationDate_idx"
  ON "BenefitsEnrollment" ("associateId", "terminationDate");
CREATE INDEX "BenefitsEnrollment_planId_idx"
  ON "BenefitsEnrollment" ("planId");

ALTER TABLE "PayrollItem"
  ADD COLUMN "preTaxDeductions" DECIMAL(12, 2) NOT NULL DEFAULT 0;
