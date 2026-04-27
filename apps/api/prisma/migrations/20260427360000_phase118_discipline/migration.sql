-- Phase 118 — Disciplinary action log. Distinct from Pip (improvement plan).
-- This is the formal warning ladder: verbal → written → final → suspension →
-- termination. Each row is its own incident. Acknowledgment is captured as a
-- timestamp + signature blob (free text).
CREATE TYPE "DisciplineKind" AS ENUM (
  'VERBAL_WARNING',
  'WRITTEN_WARNING',
  'FINAL_WARNING',
  'SUSPENSION',
  'TERMINATION'
);

CREATE TYPE "DisciplineStatus" AS ENUM (
  'ACTIVE',
  'ACKNOWLEDGED',
  'RESCINDED'
);

CREATE TABLE "DisciplinaryAction" (
  "id"                UUID                NOT NULL DEFAULT gen_random_uuid(),
  "associateId"       UUID                NOT NULL,
  "kind"              "DisciplineKind"    NOT NULL,
  "status"            "DisciplineStatus"  NOT NULL DEFAULT 'ACTIVE',
  "incidentDate"      DATE                NOT NULL,
  "effectiveDate"     DATE                NOT NULL,
  "suspensionDays"    INTEGER,
  "description"       TEXT                NOT NULL,
  "expectedAction"    TEXT,
  "issuedById"        UUID,
  "acknowledgedAt"    TIMESTAMPTZ(6),
  "acknowledgedSig"   TEXT,
  "rescindedAt"       TIMESTAMPTZ(6),
  "rescindedReason"   TEXT,
  "rescindedById"     UUID,
  "createdAt"         TIMESTAMPTZ(6)      NOT NULL DEFAULT NOW(),
  "updatedAt"         TIMESTAMPTZ(6)      NOT NULL,
  CONSTRAINT "DisciplinaryAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DisciplinaryAction_associateId_idx" ON "DisciplinaryAction"("associateId");
CREATE INDEX "DisciplinaryAction_status_idx" ON "DisciplinaryAction"("status");
CREATE INDEX "DisciplinaryAction_effectiveDate_idx" ON "DisciplinaryAction"("effectiveDate");

ALTER TABLE "DisciplinaryAction" ADD CONSTRAINT "DisciplinaryAction_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DisciplinaryAction" ADD CONSTRAINT "DisciplinaryAction_issuedById_fkey"
  FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DisciplinaryAction" ADD CONSTRAINT "DisciplinaryAction_rescindedById_fkey"
  FOREIGN KEY ("rescindedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
