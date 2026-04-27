-- Phase 121 — Vaccination + medical records. Important for healthcare /
-- staffing where client SLAs require proof. Each row is one shot or test.
-- expiresOn drives the expirations dashboard via an external feed.
CREATE TYPE "VaccinationKind" AS ENUM (
  'COVID19',
  'INFLUENZA_FLU',
  'HEPATITIS_B',
  'TDAP',
  'MMR',
  'TB_TEST',
  'OTHER'
);

CREATE TABLE "VaccinationRecord" (
  "id"             UUID              NOT NULL DEFAULT gen_random_uuid(),
  "associateId"    UUID              NOT NULL,
  "kind"           "VaccinationKind" NOT NULL,
  "customLabel"    TEXT,
  "doseNumber"     INTEGER           NOT NULL DEFAULT 1,
  "totalDoses"     INTEGER,
  "administeredOn" DATE              NOT NULL,
  "administeredBy" TEXT,
  "manufacturer"   TEXT,
  "lotNumber"      TEXT,
  "documentUrl"    TEXT,
  "expiresOn"      DATE,
  "notes"          TEXT,
  "createdById"    UUID,
  "createdAt"      TIMESTAMPTZ(6)    NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ(6)    NOT NULL,
  CONSTRAINT "VaccinationRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VaccinationRecord_associateId_idx" ON "VaccinationRecord"("associateId");
CREATE INDEX "VaccinationRecord_kind_idx" ON "VaccinationRecord"("kind");
CREATE INDEX "VaccinationRecord_expiresOn_idx" ON "VaccinationRecord"("expiresOn");

ALTER TABLE "VaccinationRecord" ADD CONSTRAINT "VaccinationRecord_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaccinationRecord" ADD CONSTRAINT "VaccinationRecord_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
