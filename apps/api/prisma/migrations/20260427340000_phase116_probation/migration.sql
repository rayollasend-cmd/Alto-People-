-- Phase 116 — Probation period tracking. New hires typically have a 30/60/90
-- day probation; manager confirms PASSED, EXTENDED (with new endDate), or
-- FAILED (separation triggered out-of-band). One ACTIVE row per associate at
-- a time — enforced by a partial unique index so historical probations can
-- coexist with a new ACTIVE one after a re-hire.
CREATE TYPE "ProbationStatus" AS ENUM (
  'ACTIVE',
  'PASSED',
  'EXTENDED',
  'FAILED'
);

CREATE TABLE "ProbationPeriod" (
  "id"           UUID              NOT NULL DEFAULT gen_random_uuid(),
  "associateId"  UUID              NOT NULL,
  "startDate"    DATE              NOT NULL,
  "endDate"      DATE              NOT NULL,
  "status"       "ProbationStatus" NOT NULL DEFAULT 'ACTIVE',
  "decision"     TEXT,
  "decidedById"  UUID,
  "decidedAt"    TIMESTAMPTZ(6),
  "createdById"  UUID,
  "createdAt"    TIMESTAMPTZ(6)    NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ(6)    NOT NULL,
  CONSTRAINT "ProbationPeriod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProbationPeriod_associateId_idx"
  ON "ProbationPeriod"("associateId");
CREATE INDEX "ProbationPeriod_endDate_idx"
  ON "ProbationPeriod"("endDate");
CREATE UNIQUE INDEX "ProbationPeriod_active_per_associate_idx"
  ON "ProbationPeriod"("associateId")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "ProbationPeriod" ADD CONSTRAINT "ProbationPeriod_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProbationPeriod" ADD CONSTRAINT "ProbationPeriod_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProbationPeriod" ADD CONSTRAINT "ProbationPeriod_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
