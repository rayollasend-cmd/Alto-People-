-- Phase 115 — Succession planning. Per-position list of associates flagged as
-- ready to step in, with a readiness band. The unique (positionId, associateId)
-- prevents listing the same person twice on the same position; the
-- (associateId) index supports "what positions am I a successor for?" lookups.
CREATE TYPE "SuccessionReadiness" AS ENUM (
  'READY_NOW',
  'READY_1_2_YEARS',
  'READY_3_PLUS_YEARS',
  'EMERGENCY_COVER'
);

CREATE TABLE "SuccessionCandidate" (
  "id"           UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "positionId"   UUID                  NOT NULL,
  "associateId"  UUID                  NOT NULL,
  "readiness"    "SuccessionReadiness" NOT NULL,
  "notes"        TEXT,
  "createdById"  UUID,
  "createdAt"    TIMESTAMPTZ(6)        NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ(6)        NOT NULL,
  CONSTRAINT "SuccessionCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SuccessionCandidate_position_associate_key"
  ON "SuccessionCandidate"("positionId", "associateId");
CREATE INDEX "SuccessionCandidate_associateId_idx"
  ON "SuccessionCandidate"("associateId");
CREATE INDEX "SuccessionCandidate_positionId_idx"
  ON "SuccessionCandidate"("positionId");

ALTER TABLE "SuccessionCandidate" ADD CONSTRAINT "SuccessionCandidate_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SuccessionCandidate" ADD CONSTRAINT "SuccessionCandidate_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SuccessionCandidate" ADD CONSTRAINT "SuccessionCandidate_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
