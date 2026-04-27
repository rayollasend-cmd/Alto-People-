-- Phase 85 — Qualifications + open-shift marketplace.
--
-- Three tables:
--   Qualification              — catalog of badges (Forklift, TIPS card,
--                                bilingual, etc.) per client (or global).
--   AssociateQualification     — associate ↔ qualification with optional
--                                acquired/expiry date.
--   ShiftQualificationRequirement
--                              — qualifications required for a shift.
--   OpenShiftClaim             — associate-side request to pick up an OPEN
--                                shift. Manager APPROVES/REJECTS.

CREATE TYPE "OpenShiftClaimStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED'
);

CREATE TABLE "Qualification" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = global / multi-tenant catalog entry.
  "clientId"    UUID,
  "code"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  -- True for cert / license-style qualifications that have an expiry.
  -- Drives Phase 88 OSHA / compliance-expiring trigger.
  "isCert"      BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "Qualification_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "Qualification_clientId_code_unique"
  ON "Qualification" ("clientId", "code")
  WHERE "deletedAt" IS NULL;
CREATE INDEX "Qualification_clientId_idx" ON "Qualification" ("clientId");

CREATE TABLE "AssociateQualification" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"    UUID NOT NULL,
  "qualificationId" UUID NOT NULL,
  "acquiredAt"     DATE,
  "expiresAt"      DATE,
  -- Optional URL/storage key for cert PDFs uploaded.
  "evidenceKey"    TEXT,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"      TIMESTAMPTZ(6),
  CONSTRAINT "AssociateQualification_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "AssociateQualification_qualificationId_fkey"
    FOREIGN KEY ("qualificationId") REFERENCES "Qualification"("id") ON DELETE CASCADE
);
-- One row per (associate, qualification) — re-credentialing updates in place.
CREATE UNIQUE INDEX "AssociateQualification_associateId_qualificationId_unique"
  ON "AssociateQualification" ("associateId", "qualificationId")
  WHERE "deletedAt" IS NULL;
CREATE INDEX "AssociateQualification_expiresAt_idx"
  ON "AssociateQualification" ("expiresAt") WHERE "expiresAt" IS NOT NULL;

CREATE TABLE "ShiftQualificationRequirement" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shiftId"        UUID NOT NULL,
  "qualificationId" UUID NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ShiftQualificationRequirement_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE,
  CONSTRAINT "ShiftQualificationRequirement_qualificationId_fkey"
    FOREIGN KEY ("qualificationId") REFERENCES "Qualification"("id") ON DELETE CASCADE,
  CONSTRAINT "ShiftQualificationRequirement_unique"
    UNIQUE ("shiftId", "qualificationId")
);
CREATE INDEX "ShiftQualificationRequirement_shiftId_idx"
  ON "ShiftQualificationRequirement" ("shiftId");

CREATE TABLE "OpenShiftClaim" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shiftId"        UUID NOT NULL,
  "associateId"    UUID NOT NULL,
  "status"         "OpenShiftClaimStatus" NOT NULL DEFAULT 'PENDING',
  "decidedById"    UUID,
  "decidedAt"      TIMESTAMPTZ(6),
  "decisionNote"   TEXT,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "OpenShiftClaim_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE,
  CONSTRAINT "OpenShiftClaim_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "OpenShiftClaim_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL
);
-- One PENDING claim per (associate, shift). They can WITHDRAW and try
-- again, but at any moment there's only one in-flight request.
CREATE UNIQUE INDEX "OpenShiftClaim_pending_unique"
  ON "OpenShiftClaim" ("shiftId", "associateId")
  WHERE "status" = 'PENDING';
CREATE INDEX "OpenShiftClaim_shiftId_status_idx"
  ON "OpenShiftClaim" ("shiftId", "status");
CREATE INDEX "OpenShiftClaim_associateId_status_idx"
  ON "OpenShiftClaim" ("associateId", "status");
