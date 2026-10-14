-- Brief 2-5 step 1 — the evidence spine. Additive: two new tables and an
-- enum; nothing existing is read or changed. Reversible by dropping the
-- two tables, their triggers and the enum (nothing references them).
--
-- Platform-level (owner's decision 1, 2026-10-13): SOC 2 evidence belongs
-- to Alto People as the service organization, so tenantId is nullable with
-- no default, like the other platform-wide tables (ApiBoot, ReliabilityWeek).

CREATE TYPE "EvidenceStatus" AS ENUM ('PASS', 'FAIL', 'WARN');

CREATE TABLE "ComplianceEvidence" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID,
  "control"     VARCHAR(80) NOT NULL,
  "status"      "EvidenceStatus" NOT NULL,
  "summary"     VARCHAR(500) NOT NULL,
  "details"     JSONB NOT NULL DEFAULT '{}',
  "artifactKey" VARCHAR(500),
  "collectedBy" VARCHAR(120) NOT NULL,
  "collectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "periodStart" TIMESTAMPTZ(6),
  "periodEnd"   TIMESTAMPTZ(6),
  CONSTRAINT "ComplianceEvidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComplianceEvidence_control_collectedAt_idx" ON "ComplianceEvidence"("control", "collectedAt" DESC);
CREATE INDEX "ComplianceEvidence_tenantId_idx" ON "ComplianceEvidence"("tenantId");

CREATE TABLE "ComplianceEvidenceSignoff" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID,
  "evidenceId"    UUID NOT NULL,
  "signedOffById" UUID NOT NULL,
  "note"          VARCHAR(1000),
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplianceEvidenceSignoff_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComplianceEvidenceSignoff_evidenceId_idx" ON "ComplianceEvidenceSignoff"("evidenceId");
CREATE INDEX "ComplianceEvidenceSignoff_tenantId_idx" ON "ComplianceEvidenceSignoff"("tenantId");
ALTER TABLE "ComplianceEvidenceSignoff" ADD CONSTRAINT "ComplianceEvidenceSignoff_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "ComplianceEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Evidence is append-only: no row is edited or deleted, ever (a sign-off is
-- its own row). Row-level triggers do not fire on TRUNCATE, so the test
-- harness's reset between files is unaffected — the AuditLog pattern.
CREATE OR REPLACE FUNCTION compliance_evidence_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be %', TG_TABLE_NAME, lower(TG_OP) || 'd'
    USING ERRCODE = 'restrict_violation';
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS compliance_evidence_immutable ON "ComplianceEvidence";
CREATE TRIGGER compliance_evidence_immutable
  BEFORE UPDATE OR DELETE ON "ComplianceEvidence"
  FOR EACH ROW EXECUTE FUNCTION compliance_evidence_immutable();

DROP TRIGGER IF EXISTS compliance_evidence_signoff_immutable ON "ComplianceEvidenceSignoff";
CREATE TRIGGER compliance_evidence_signoff_immutable
  BEFORE UPDATE OR DELETE ON "ComplianceEvidenceSignoff"
  FOR EACH ROW EXECUTE FUNCTION compliance_evidence_immutable();
