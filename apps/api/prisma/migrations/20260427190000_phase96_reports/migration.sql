-- Phase 96 — Reporting builder: saved reports + scheduled deliveries.
-- A report is (entity, columns, filters, sort, groupBy). Stored as
-- JSON; the runner translates it into a Prisma query at execution time.

CREATE TYPE "ReportEntity" AS ENUM (
  'ASSOCIATE',
  'TIME_ENTRY',
  'PAYROLL_ITEM',
  'PAYROLL_RUN',
  'APPLICATION',
  'EXPENSE',
  'CANDIDATE'
);

CREATE TYPE "ReportScheduleCadence" AS ENUM (
  'DAILY',
  'WEEKLY',
  'MONTHLY'
);

CREATE TABLE "Report" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "entity"      "ReportEntity" NOT NULL,
  -- Spec: { columns: [...], filters: [...], sort: [...], groupBy: [...] }
  "spec"        JSONB NOT NULL,
  "isPublic"    BOOLEAN NOT NULL DEFAULT FALSE,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "Report_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "Report_entity_idx" ON "Report" ("entity");

CREATE TABLE "ReportSchedule" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reportId"     UUID NOT NULL,
  "cadence"      "ReportScheduleCadence" NOT NULL,
  -- Comma-separated list of email addresses.
  "recipients"   TEXT NOT NULL,
  "isActive"     BOOLEAN NOT NULL DEFAULT TRUE,
  "lastRunAt"    TIMESTAMPTZ(6),
  "nextRunAt"    TIMESTAMPTZ(6) NOT NULL,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ReportSchedule_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE
);
CREATE INDEX "ReportSchedule_nextRunAt_idx"
  ON "ReportSchedule" ("isActive", "nextRunAt");
