-- Phase 122 — Per-associate legal agreements (NDA, non-compete, IP
-- assignment, arbitration, equity grants). Distinct from PolicyAck which
-- is for company-wide policies. supersedesId points at an older agreement
-- the new one replaces (e.g., updated NDA after a role change).
CREATE TYPE "AgreementKind" AS ENUM (
  'NDA',
  'NON_COMPETE',
  'IP_ASSIGNMENT',
  'ARBITRATION',
  'EMPLOYMENT_OFFER',
  'SEPARATION_AGREEMENT',
  'EQUITY_GRANT',
  'OTHER'
);

CREATE TYPE "AgreementStatus" AS ENUM (
  'PENDING_SIGNATURE',
  'SIGNED',
  'EXPIRED',
  'SUPERSEDED'
);

CREATE TABLE "Agreement" (
  "id"            UUID               NOT NULL DEFAULT gen_random_uuid(),
  "associateId"   UUID               NOT NULL,
  "kind"          "AgreementKind"    NOT NULL,
  "customLabel"   TEXT,
  "status"        "AgreementStatus"  NOT NULL DEFAULT 'PENDING_SIGNATURE',
  "documentUrl"   TEXT,
  "effectiveDate" DATE,
  "expiresOn"     DATE,
  "signedAt"      TIMESTAMPTZ(6),
  "signature"     TEXT,
  "supersedesId"  UUID,
  "notes"         TEXT,
  "issuedById"    UUID,
  "createdAt"     TIMESTAMPTZ(6)     NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ(6)     NOT NULL,
  CONSTRAINT "Agreement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Agreement_associateId_idx" ON "Agreement"("associateId");
CREATE INDEX "Agreement_status_idx" ON "Agreement"("status");
CREATE INDEX "Agreement_expiresOn_idx" ON "Agreement"("expiresOn");

ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "Agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_issuedById_fkey"
  FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
