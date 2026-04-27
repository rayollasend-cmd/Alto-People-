-- Phase 123 — HR ticketing / case management. Zendesk for HR. Associates
-- file cases, HR routes/triages/resolves. Comments support an internalNote
-- flag so HR can leave breadcrumbs that the associate doesn't see.
CREATE TYPE "CaseCategory" AS ENUM (
  'BENEFITS',
  'PAYROLL',
  'TIME_OFF',
  'PERSONAL_INFO',
  'WORKPLACE_CONCERN',
  'HARASSMENT',
  'PERFORMANCE',
  'OTHER'
);

CREATE TYPE "CasePriority" AS ENUM (
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT'
);

CREATE TYPE "CaseStatus" AS ENUM (
  'OPEN',
  'IN_PROGRESS',
  'WAITING_ASSOCIATE',
  'RESOLVED',
  'CLOSED'
);

CREATE TABLE "HrCase" (
  "id"             UUID             NOT NULL DEFAULT gen_random_uuid(),
  "associateId"    UUID             NOT NULL,
  "category"       "CaseCategory"   NOT NULL,
  "subject"        TEXT             NOT NULL,
  "description"    TEXT             NOT NULL,
  "priority"       "CasePriority"   NOT NULL DEFAULT 'MEDIUM',
  "status"         "CaseStatus"     NOT NULL DEFAULT 'OPEN',
  "assignedToId"   UUID,
  "resolvedAt"     TIMESTAMPTZ(6),
  "resolution"     TEXT,
  "createdAt"      TIMESTAMPTZ(6)   NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ(6)   NOT NULL,
  CONSTRAINT "HrCase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HrCase_associateId_idx" ON "HrCase"("associateId");
CREATE INDEX "HrCase_status_idx" ON "HrCase"("status");
CREATE INDEX "HrCase_category_idx" ON "HrCase"("category");
CREATE INDEX "HrCase_assignedToId_idx" ON "HrCase"("assignedToId");

ALTER TABLE "HrCase" ADD CONSTRAINT "HrCase_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HrCase" ADD CONSTRAINT "HrCase_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "HrCaseComment" (
  "id"                UUID            NOT NULL DEFAULT gen_random_uuid(),
  "caseId"            UUID            NOT NULL,
  "authorUserId"      UUID,
  "authorAssociateId" UUID,
  "body"              TEXT            NOT NULL,
  "internalNote"      BOOLEAN         NOT NULL DEFAULT FALSE,
  "createdAt"         TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "HrCaseComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HrCaseComment_caseId_idx" ON "HrCaseComment"("caseId");

ALTER TABLE "HrCaseComment" ADD CONSTRAINT "HrCaseComment_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "HrCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HrCaseComment" ADD CONSTRAINT "HrCaseComment_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HrCaseComment" ADD CONSTRAINT "HrCaseComment_authorAssociateId_fkey"
  FOREIGN KEY ("authorAssociateId") REFERENCES "Associate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
