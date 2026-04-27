-- Phase 82 — Self-service post-onboarding.
--
-- Three additive tables capturing personal data associates manage themselves
-- after onboarding closes: emergency contacts, dependents, beneficiaries.
-- Plus a LifeEvent log so HR / workflows can react to marriages, births,
-- moves, etc., and a TaxDocument table for downloadable W-2 / 1099-NEC PDFs.

CREATE TYPE "EmergencyContactRelation" AS ENUM (
  'SPOUSE',
  'PARENT',
  'CHILD',
  'SIBLING',
  'FRIEND',
  'OTHER'
);

CREATE TYPE "DependentRelation" AS ENUM (
  'SPOUSE',
  'CHILD',
  'DOMESTIC_PARTNER',
  'OTHER'
);

CREATE TYPE "BeneficiaryKind" AS ENUM (
  'PRIMARY',
  'CONTINGENT'
);

CREATE TYPE "LifeEventKind" AS ENUM (
  'MARRIAGE',
  'DIVORCE',
  'BIRTH',
  'ADOPTION',
  'DEATH_OF_DEPENDENT',
  'ADDRESS_CHANGE',
  'NAME_CHANGE',
  'OTHER'
);

CREATE TYPE "LifeEventStatus" AS ENUM (
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED'
);

CREATE TYPE "TaxDocumentKind" AS ENUM (
  'W2',
  'W3',
  '1099_NEC',
  '1095_C'
);

CREATE TABLE "EmergencyContact" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"  UUID NOT NULL,
  "name"         TEXT NOT NULL,
  "relation"     "EmergencyContactRelation" NOT NULL,
  "phone"        TEXT NOT NULL,
  "email"        TEXT,
  "isPrimary"    BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"    TIMESTAMPTZ(6),
  CONSTRAINT "EmergencyContact_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE
);
CREATE INDEX "EmergencyContact_associateId_idx" ON "EmergencyContact" ("associateId");
-- At most one primary per associate at a time (partial unique).
CREATE UNIQUE INDEX "EmergencyContact_associateId_primary_unique"
  ON "EmergencyContact" ("associateId")
  WHERE "isPrimary" = TRUE AND "deletedAt" IS NULL;

CREATE TABLE "Dependent" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"    UUID NOT NULL,
  "firstName"      TEXT NOT NULL,
  "lastName"       TEXT NOT NULL,
  "relation"       "DependentRelation" NOT NULL,
  "dob"            DATE,
  -- Encrypted at rest with the same scheme as SSN / bank numbers.
  "ssnLast4"       VARCHAR(4),
  "isCovered"      BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"      TIMESTAMPTZ(6),
  CONSTRAINT "Dependent_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE
);
CREATE INDEX "Dependent_associateId_idx" ON "Dependent" ("associateId");

CREATE TABLE "Beneficiary" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"    UUID NOT NULL,
  -- Optional link if the beneficiary is a registered dependent.
  "dependentId"    UUID,
  "name"           TEXT NOT NULL,
  "relation"       "DependentRelation" NOT NULL,
  "kind"           "BeneficiaryKind" NOT NULL DEFAULT 'PRIMARY',
  -- 0..100; primaries should sum to 100 per associate, validated in app.
  "percentage"     INTEGER NOT NULL DEFAULT 100,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"      TIMESTAMPTZ(6),
  CONSTRAINT "Beneficiary_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "Beneficiary_dependentId_fkey"
    FOREIGN KEY ("dependentId") REFERENCES "Dependent"("id") ON DELETE SET NULL,
  CONSTRAINT "Beneficiary_percentage_check"
    CHECK ("percentage" BETWEEN 0 AND 100)
);
CREATE INDEX "Beneficiary_associateId_kind_idx"
  ON "Beneficiary" ("associateId", "kind");

CREATE TABLE "LifeEvent" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"    UUID NOT NULL,
  "kind"           "LifeEventKind" NOT NULL,
  "eventDate"      DATE NOT NULL,
  "notes"          TEXT,
  "status"         "LifeEventStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "reviewedById"   UUID,
  "reviewedAt"     TIMESTAMPTZ(6),
  "reviewNote"     TEXT,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "LifeEvent_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "LifeEvent_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "LifeEvent_associateId_idx" ON "LifeEvent" ("associateId");
CREATE INDEX "LifeEvent_status_idx" ON "LifeEvent" ("status");

CREATE TABLE "TaxDocument" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"    UUID NOT NULL,
  "kind"           "TaxDocumentKind" NOT NULL,
  "taxYear"        INTEGER NOT NULL,
  -- S3 / storage key. Same convention as DocumentRecord.storageKey.
  "storageKey"     TEXT NOT NULL,
  -- sha256 of the rendered PDF for tamper detection.
  "fileHash"       VARCHAR(64),
  "fileSize"       INTEGER,
  "issuedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "TaxDocument_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "TaxDocument_associate_year_kind_unique"
    UNIQUE ("associateId", "taxYear", "kind")
);
CREATE INDEX "TaxDocument_associateId_taxYear_idx"
  ON "TaxDocument" ("associateId", "taxYear" DESC);
