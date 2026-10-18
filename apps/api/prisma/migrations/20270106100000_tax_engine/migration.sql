-- Payroll tax engine: local taxes behind a per-jurisdiction review, the
-- worker's local tax profile and certificates, the tax lines each paycheck
-- carries (state by state, local by local), and a tax-engine provider kind
-- (Symmetry / Vertex) beside the in-house engine.

ALTER TYPE "ProviderKind" ADD VALUE IF NOT EXISTS 'TAX_ENGINE';

-- "Reviewed with our tax adviser" for one local jurisdiction and tax year.
CREATE TABLE "LocalTaxAcknowledgment" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "jurisdictionCode" VARCHAR(40) NOT NULL,
  "taxYear"          INTEGER NOT NULL,
  "acknowledgedById" UUID,
  "acknowledgedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "note"             VARCHAR(500),
  CONSTRAINT "LocalTaxAcknowledgment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LocalTaxAcknowledgment_tenantId_jurisdictionCode_taxYear_key" ON "LocalTaxAcknowledgment"("tenantId", "jurisdictionCode", "taxYear");

-- Where a worker lives, as the local taxes need it (PA PSD code, Ohio city
-- and school district, Indiana county on January 1) — set by payroll when
-- the address alone can't decide it.
CREATE TABLE "AssociateTaxProfile" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"          UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"       UUID NOT NULL,
  "residentPsdCode"   VARCHAR(6),
  "residentMunicipality" VARCHAR(80),
  "residentSchoolDistrict" VARCHAR(8),
  "residentCountyJan1" VARCHAR(40),
  "residentLocalCode" VARCHAR(40),
  "notes"             VARCHAR(500),
  "updatedById"       UUID,
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AssociateTaxProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssociateTaxProfile_associateId_key" ON "AssociateTaxProfile"("associateId");
CREATE INDEX "AssociateTaxProfile_tenantId_idx" ON "AssociateTaxProfile"("tenantId");
ALTER TABLE "AssociateTaxProfile" ADD CONSTRAINT "AssociateTaxProfile_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A certificate on file: a nonresidency/reciprocity certificate (PA REV-419,
-- NJ-165, IL-W-5-NR …), the PA residency certification, Ohio IT-4 / city
-- forms, the LST low-income exemption.
CREATE TABLE "AssociateTaxCertificate" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"      UUID NOT NULL,
  "kind"             VARCHAR(40) NOT NULL,
  "state"            VARCHAR(2),
  "jurisdictionCode" VARCHAR(40),
  "formName"         VARCHAR(40),
  "signedOn"         DATE,
  "effectiveFrom"    DATE,
  "data"             JSONB NOT NULL DEFAULT '{}',
  "recordedById"     UUID,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "revokedAt"        TIMESTAMPTZ(6),
  CONSTRAINT "AssociateTaxCertificate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AssociateTaxCertificate_associateId_idx" ON "AssociateTaxCertificate"("associateId");
CREATE INDEX "AssociateTaxCertificate_tenantId_idx" ON "AssociateTaxCertificate"("tenantId");
ALTER TABLE "AssociateTaxCertificate" ADD CONSTRAINT "AssociateTaxCertificate_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every tax a paycheck carries, jurisdiction by jurisdiction.
CREATE TABLE "PayrollItemTaxLine" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "payrollItemId" UUID NOT NULL,
  "code"          VARCHAR(40) NOT NULL,
  "kind"          VARCHAR(16) NOT NULL,
  "label"         VARCHAR(160) NOT NULL,
  "resident"      BOOLEAN NOT NULL DEFAULT false,
  "workState"     VARCHAR(2),
  "wages"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  "amount"        DECIMAL(12,2) NOT NULL DEFAULT 0,
  "employer"      BOOLEAN NOT NULL DEFAULT false,
  "note"          VARCHAR(300),
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PayrollItemTaxLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayrollItemTaxLine_payrollItemId_idx" ON "PayrollItemTaxLine"("payrollItemId");
CREATE INDEX "PayrollItemTaxLine_tenantId_code_idx" ON "PayrollItemTaxLine"("tenantId", "code");
ALTER TABLE "PayrollItemTaxLine" ADD CONSTRAINT "PayrollItemTaxLine_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
