-- Phase 128 — Anonymous reporting / whistleblower hotline. Reports are
-- filed without authentication. The reporter gets a one-time tracking code
-- (random 16-char) which is the only way to look up the case afterwards;
-- HR never sees the reporter's identity unless they explicitly share a
-- contactEmail. Updates from the reporter come back through the same code.
CREATE TYPE "ReportCategory" AS ENUM (
  'HARASSMENT',
  'DISCRIMINATION',
  'ETHICS_VIOLATION',
  'FRAUD',
  'SAFETY',
  'RETALIATION',
  'OTHER'
);

CREATE TYPE "ReportStatus" AS ENUM (
  'RECEIVED',
  'TRIAGING',
  'INVESTIGATING',
  'RESOLVED',
  'CLOSED'
);

CREATE TABLE "AnonymousReport" (
  "id"            UUID              NOT NULL DEFAULT gen_random_uuid(),
  "trackingCode"  TEXT              NOT NULL,
  "category"      "ReportCategory"  NOT NULL,
  "subject"       TEXT              NOT NULL,
  "description"   TEXT              NOT NULL,
  "status"        "ReportStatus"    NOT NULL DEFAULT 'RECEIVED',
  "contactEmail"  TEXT,
  "assignedToId"  UUID,
  "resolution"    TEXT,
  "resolvedAt"    TIMESTAMPTZ(6),
  "createdAt"     TIMESTAMPTZ(6)    NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ(6)    NOT NULL,
  CONSTRAINT "AnonymousReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnonymousReport_trackingCode_key"
  ON "AnonymousReport"("trackingCode");
CREATE INDEX "AnonymousReport_status_idx" ON "AnonymousReport"("status");
CREATE INDEX "AnonymousReport_category_idx" ON "AnonymousReport"("category");

ALTER TABLE "AnonymousReport" ADD CONSTRAINT "AnonymousReport_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AnonymousReportUpdate" (
  "id"             UUID            NOT NULL DEFAULT gen_random_uuid(),
  "reportId"       UUID            NOT NULL,
  "body"           TEXT            NOT NULL,
  "authorUserId"   UUID,
  "isFromReporter" BOOLEAN         NOT NULL DEFAULT FALSE,
  "internalOnly"   BOOLEAN         NOT NULL DEFAULT FALSE,
  "createdAt"      TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "AnonymousReportUpdate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnonymousReportUpdate_reportId_idx"
  ON "AnonymousReportUpdate"("reportId");

ALTER TABLE "AnonymousReportUpdate" ADD CONSTRAINT "AnonymousReportUpdate_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "AnonymousReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnonymousReportUpdate" ADD CONSTRAINT "AnonymousReportUpdate_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
