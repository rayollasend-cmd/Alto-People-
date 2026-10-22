-- 2026-10-21 system audit, Tier 1 #3 and #14: hiring compliance.
--
-- NOT_RUN: a self-serve background-check consent with no screening provider
-- connected used to be written as PASSED. It is now recorded honestly as a
-- check that never ran, and the hire-ready gate names it.
ALTER TYPE "BgCheckStatus" ADD VALUE IF NOT EXISTS 'NOT_RUN';

-- Voluntary applicant EEO self-identification, kept apart from the candidate
-- and the application; read only by the aggregate report.
CREATE TABLE "EeoSelfIdentification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "candidateId" UUID,
    "associateId" UUID,
    "gender" VARCHAR(20),
    "ethnicity" VARCHAR(40),
    "veteranStatus" VARCHAR(30),
    "disabilityStatus" VARCHAR(30),
    "declined" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EeoSelfIdentification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EeoSelfIdentification_candidateId_key" ON "EeoSelfIdentification"("candidateId");
CREATE UNIQUE INDEX "EeoSelfIdentification_associateId_key" ON "EeoSelfIdentification"("associateId");
CREATE INDEX "EeoSelfIdentification_tenantId_submittedAt_idx" ON "EeoSelfIdentification"("tenantId", "submittedAt");

ALTER TABLE "EeoSelfIdentification" ADD CONSTRAINT "EeoSelfIdentification_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EeoSelfIdentification" ADD CONSTRAINT "EeoSelfIdentification_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
