-- Phase 91 — Garnishments + tax forms (941, 940, W-2, 1099-NEC).
-- Garnishments are recurring deductions tied to an associate; tax forms
-- are immutable filings with line-item amounts captured at filing time.

CREATE TYPE "GarnishmentKind" AS ENUM (
  'CHILD_SUPPORT',
  'TAX_LEVY',
  'STUDENT_LOAN',
  'BANKRUPTCY',
  'CREDITOR',
  'OTHER'
);

CREATE TYPE "GarnishmentStatus" AS ENUM (
  'ACTIVE',
  'SUSPENDED',
  'COMPLETED',
  'TERMINATED'
);

CREATE TYPE "TaxFormKind" AS ENUM (
  'F941',
  'F940',
  'W2',
  'F1099_NEC'
);

CREATE TYPE "TaxFormStatus" AS ENUM (
  'DRAFT',
  'FILED',
  'AMENDED',
  'VOIDED'
);

CREATE TABLE "Garnishment" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"   UUID NOT NULL,
  "kind"          "GarnishmentKind" NOT NULL,
  "caseNumber"    TEXT,
  "agencyName"    TEXT,
  -- Either a fixed amount per pay run, OR a % of disposable earnings.
  -- Constraint enforces one-and-only-one is set.
  "amountPerRun"  DECIMAL(10, 2),
  "percentOfDisp" DECIMAL(5, 4),
  -- Cap on cumulative collection — once "amountWithheld" reaches this,
  -- the garnishment auto-completes. NULL = no cap (recurring forever).
  "totalCap"      DECIMAL(12, 2),
  "amountWithheld" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "remitTo"       TEXT,
  "remitAddress"  TEXT,
  "startDate"     DATE NOT NULL,
  "endDate"       DATE,
  "status"        "GarnishmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "priority"      INTEGER NOT NULL DEFAULT 100,
  "notes"         TEXT,
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"     TIMESTAMPTZ(6),
  CONSTRAINT "Garnishment_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "Garnishment_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "Garnishment_amount_check"
    CHECK (
      ("amountPerRun" IS NOT NULL AND "percentOfDisp" IS NULL)
      OR ("amountPerRun" IS NULL AND "percentOfDisp" IS NOT NULL)
    )
);
CREATE INDEX "Garnishment_associateId_idx" ON "Garnishment" ("associateId");
CREATE INDEX "Garnishment_status_idx" ON "Garnishment" ("status");

-- Per-pay-run withholding records, so we can prove what we deducted
-- when in case of an audit/appeal.
CREATE TABLE "GarnishmentDeduction" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "garnishmentId"  UUID NOT NULL,
  "payrollRunId"   UUID,
  "amount"         DECIMAL(10, 2) NOT NULL,
  "deductedOn"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "GarnishmentDeduction_garnishmentId_fkey"
    FOREIGN KEY ("garnishmentId") REFERENCES "Garnishment"("id") ON DELETE CASCADE,
  CONSTRAINT "GarnishmentDeduction_payrollRunId_fkey"
    FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL
);
CREATE INDEX "GarnishmentDeduction_garnishmentId_idx"
  ON "GarnishmentDeduction" ("garnishmentId");

-- Tax forms: 941 (quarterly federal), 940 (annual FUTA),
-- W-2 (per-employee annual), 1099-NEC (per-contractor annual).
CREATE TABLE "TaxForm" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"         "TaxFormKind" NOT NULL,
  -- For 941: 1-4. For 940/W-2/1099: NULL.
  "quarter"      INTEGER,
  "taxYear"      INTEGER NOT NULL,
  -- For W-2 / 1099, the recipient. Otherwise NULL.
  "associateId"  UUID,
  -- Snapshot of all line-item amounts (wages, tax, etc) — schema varies
  -- per form kind, so JSON is the right shape here.
  "amounts"      JSONB NOT NULL,
  "status"       "TaxFormStatus" NOT NULL DEFAULT 'DRAFT',
  "filedAt"      TIMESTAMPTZ(6),
  "filedById"    UUID,
  "ein"          VARCHAR(20),
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TaxForm_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE SET NULL,
  CONSTRAINT "TaxForm_filedById_fkey"
    FOREIGN KEY ("filedById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "TaxForm_quarter_check"
    CHECK (
      ("kind" = 'F941' AND "quarter" IS NOT NULL AND "quarter" BETWEEN 1 AND 4)
      OR ("kind" <> 'F941' AND "quarter" IS NULL)
    ),
  CONSTRAINT "TaxForm_recipient_check"
    CHECK (
      ("kind" IN ('W2', 'F1099_NEC') AND "associateId" IS NOT NULL)
      OR ("kind" IN ('F941', 'F940') AND "associateId" IS NULL)
    )
);
CREATE INDEX "TaxForm_kind_year_idx" ON "TaxForm" ("kind", "taxYear");
CREATE INDEX "TaxForm_associateId_idx" ON "TaxForm" ("associateId");
-- One form per (kind, year, quarter, associate) — except draft amendments.
CREATE UNIQUE INDEX "TaxForm_unique_filed"
  ON "TaxForm" ("kind", "taxYear", COALESCE("quarter", 0), COALESCE("associateId", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "status" = 'FILED';
