-- Brief 2-6 step 3 — the automated-decision record: what each agent capability decides
-- about people, its bias audits, and an append-only record of every decision about a
-- person (NYC Local Law 144, Colorado). Additive.

-- CreateTable
CREATE TABLE "AgentDecisionProfile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "workerId" UUID NOT NULL,
    "capabilityKey" VARCHAR(80) NOT NULL,
    "decisionTypes" TEXT[],
    "jurisdictions" TEXT[],
    "assesses" VARCHAR(1000) NOT NULL,
    "dataSources" VARCHAR(1000) NOT NULL,
    "retentionPolicy" VARCHAR(300) NOT NULL,
    "humanReview" VARCHAR(12) NOT NULL DEFAULT 'ALWAYS',
    "noticeStartedAt" TIMESTAMPTZ(6),
    "noticeTextVersion" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AgentDecisionProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentBiasAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "workerId" UUID NOT NULL,
    "auditorName" VARCHAR(200) NOT NULL,
    "independenceAttested" BOOLEAN NOT NULL,
    "independenceText" VARCHAR(1000) NOT NULL,
    "conductedAt" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "distributionDate" DATE,
    "summaryUrl" VARCHAR(1000),
    "results" JSONB NOT NULL,
    "dataKind" VARCHAR(12) NOT NULL,
    "testDataReason" VARCHAR(1000),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentBiasAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomatedDecisionRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "workerId" UUID NOT NULL,
    "capabilityKey" VARCHAR(80) NOT NULL,
    "decisionType" VARCHAR(20) NOT NULL,
    "subjectAssociateId" UUID,
    "subjectRef" VARCHAR(120),
    "jurisdictionTags" TEXT[],
    "proposalId" UUID,
    "approvalId" UUID,
    "humanReviewerId" UUID,
    "humanDecidedAt" TIMESTAMPTZ(6),
    "outcome" VARCHAR(10) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "noticeGivenAt" TIMESTAMPTZ(6),
    "noticeChannel" VARCHAR(20),
    "noticeTextVersion" INTEGER,
    "auditId" UUID,
    "explanationSentAt" TIMESTAMPTZ(6),
    "reviewRequestedAt" TIMESTAMPTZ(6),
    "reviewResolvedAt" TIMESTAMPTZ(6),
    "dataRequestAt" TIMESTAMPTZ(6),
    "dataSentAt" TIMESTAMPTZ(6),
    "correctsId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomatedDecisionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentDecisionProfile_tenantId_idx" ON "AgentDecisionProfile"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDecisionProfile_workerId_capabilityKey_key" ON "AgentDecisionProfile"("workerId", "capabilityKey");

-- CreateIndex
CREATE INDEX "AgentBiasAudit_tenantId_workerId_idx" ON "AgentBiasAudit"("tenantId", "workerId");

-- CreateIndex
CREATE INDEX "AutomatedDecisionRecord_tenantId_workerId_createdAt_idx" ON "AutomatedDecisionRecord"("tenantId", "workerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AutomatedDecisionRecord_subjectAssociateId_idx" ON "AutomatedDecisionRecord"("subjectAssociateId");

ALTER TABLE "AgentDecisionProfile" ADD CONSTRAINT "AgentDecisionProfile_review_check" CHECK ("humanReview" IN ('ALWAYS', 'ON_REQUEST'));
ALTER TABLE "AgentBiasAudit" ADD CONSTRAINT "AgentBiasAudit_kind_check" CHECK ("dataKind" IN ('HISTORICAL', 'TEST') AND ("dataKind" = 'HISTORICAL' OR "testDataReason" IS NOT NULL));
ALTER TABLE "AutomatedDecisionRecord" ADD CONSTRAINT "AutomatedDecisionRecord_outcome_check" CHECK ("outcome" IN ('FAVORABLE', 'ADVERSE', 'NONE'));
ALTER TABLE "AutomatedDecisionRecord" ADD CONSTRAINT "AutomatedDecisionRecord_subject_check" CHECK ("subjectAssociateId" IS NOT NULL OR "subjectRef" IS NOT NULL);

-- Append-only, as AuditLog: no delete; the decision itself never changes; each lifecycle
-- date (notice, explanation, review, data request) is set once, from empty, and never moved.
-- TRUNCATE is refused unless the session is the test harness (alto.allow_audit_truncate).
CREATE OR REPLACE FUNCTION automated_decision_record_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AutomatedDecisionRecord is append-only: rows cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."workerId" IS DISTINCT FROM OLD."workerId"
     OR NEW."capabilityKey" IS DISTINCT FROM OLD."capabilityKey"
     OR NEW."decisionType" IS DISTINCT FROM OLD."decisionType"
     OR NEW."subjectAssociateId" IS DISTINCT FROM OLD."subjectAssociateId"
     OR NEW."subjectRef" IS DISTINCT FROM OLD."subjectRef"
     OR NEW."jurisdictionTags" IS DISTINCT FROM OLD."jurisdictionTags"
     OR NEW."proposalId" IS DISTINCT FROM OLD."proposalId"
     OR NEW."approvalId" IS DISTINCT FROM OLD."approvalId"
     OR NEW."humanReviewerId" IS DISTINCT FROM OLD."humanReviewerId"
     OR NEW."humanDecidedAt" IS DISTINCT FROM OLD."humanDecidedAt"
     OR NEW."outcome" IS DISTINCT FROM OLD."outcome"
     OR NEW."summary" IS DISTINCT FROM OLD."summary"
     OR NEW."auditId" IS DISTINCT FROM OLD."auditId"
     OR NEW."correctsId" IS DISTINCT FROM OLD."correctsId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."noticeGivenAt" IS NOT NULL AND NEW."noticeGivenAt" IS DISTINCT FROM OLD."noticeGivenAt")
     OR (OLD."noticeChannel" IS NOT NULL AND NEW."noticeChannel" IS DISTINCT FROM OLD."noticeChannel")
     OR (OLD."noticeTextVersion" IS NOT NULL AND NEW."noticeTextVersion" IS DISTINCT FROM OLD."noticeTextVersion")
     OR (OLD."explanationSentAt" IS NOT NULL AND NEW."explanationSentAt" IS DISTINCT FROM OLD."explanationSentAt")
     OR (OLD."reviewRequestedAt" IS NOT NULL AND NEW."reviewRequestedAt" IS DISTINCT FROM OLD."reviewRequestedAt")
     OR (OLD."reviewResolvedAt" IS NOT NULL AND NEW."reviewResolvedAt" IS DISTINCT FROM OLD."reviewResolvedAt")
     OR (OLD."dataRequestAt" IS NOT NULL AND NEW."dataRequestAt" IS DISTINCT FROM OLD."dataRequestAt")
     OR (OLD."dataSentAt" IS NOT NULL AND NEW."dataSentAt" IS DISTINCT FROM OLD."dataSentAt") THEN
    RAISE EXCEPTION 'AutomatedDecisionRecord is append-only: a decision is corrected by a new row, and a date once set stays'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER automated_decision_record_immutable
  BEFORE UPDATE OR DELETE ON "AutomatedDecisionRecord"
  FOR EACH ROW EXECUTE FUNCTION automated_decision_record_immutable();

CREATE OR REPLACE FUNCTION automated_decision_record_no_truncate() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('alto.allow_audit_truncate', true), '') <> 'test' THEN
    RAISE EXCEPTION 'AutomatedDecisionRecord is append-only: the table cannot be truncated'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER automated_decision_record_no_truncate
  BEFORE TRUNCATE ON "AutomatedDecisionRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION automated_decision_record_no_truncate();
