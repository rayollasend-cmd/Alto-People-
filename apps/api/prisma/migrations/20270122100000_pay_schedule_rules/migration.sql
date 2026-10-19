-- Pay schedules decided by RULES and applied from an EFFECTIVE DATE.
--
--   PayrollScheduleRule        who belongs: a whole client, a site, a
--                              department, a pay type, an individual, or an
--                              exclusion — each from a date (lib/payScheduleMembership).
--   PayrollScheduleAssignment  the membership history the rules produce:
--                              one schedule per person per day, never
--                              overlapping; a payroll run pays exactly the
--                              people (and the days) on its schedule.
--   PayrollScheduleVersion     the pattern history: a frequency / first day /
--                              payday change starts with a future period and
--                              never reframes past ones.
--   PayrollSchedule.isDefault  the company default: anyone no rule covers.
--   PayrollRun.payrollScheduleId  the schedule a run pays.

CREATE TABLE "PayrollScheduleRule" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "scheduleId"    UUID NOT NULL,
  "kind"          VARCHAR(16) NOT NULL,
  "clientId"      UUID,
  "siteId"        UUID,
  "departmentId"  UUID,
  "payType"       VARCHAR(8),
  "associateId"   UUID,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo"   DATE,
  "note"          VARCHAR(500),
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PayrollScheduleRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollScheduleRule_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "PayrollSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PayrollScheduleRule_kind_check" CHECK ("kind" IN ('INDIVIDUAL', 'SITE', 'DEPARTMENT', 'CLIENT', 'PAY_TYPE', 'EXCLUDE')),
  CONSTRAINT "PayrollScheduleRule_dates_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);
CREATE INDEX "PayrollScheduleRule_scheduleId_idx" ON "PayrollScheduleRule"("scheduleId");
CREATE INDEX "PayrollScheduleRule_tenantId_kind_idx" ON "PayrollScheduleRule"("tenantId", "kind");
CREATE INDEX "PayrollScheduleRule_associateId_idx" ON "PayrollScheduleRule"("associateId");

CREATE TABLE "PayrollScheduleAssignment" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"   UUID NOT NULL,
  "scheduleId"    UUID NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo"   DATE,
  "source"        VARCHAR(16) NOT NULL,
  "ruleId"        UUID,
  "reason"        VARCHAR(300),
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PayrollScheduleAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollScheduleAssignment_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PayrollScheduleAssignment_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "PayrollSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PayrollScheduleAssignment_source_check" CHECK ("source" IN ('RULE', 'INDIVIDUAL', 'TRANSFER', 'DEFAULT', 'MIGRATION', 'MOVE')),
  CONSTRAINT "PayrollScheduleAssignment_dates_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);
CREATE INDEX "PayrollScheduleAssignment_associateId_effectiveFrom_idx" ON "PayrollScheduleAssignment"("associateId", "effectiveFrom");
CREATE INDEX "PayrollScheduleAssignment_scheduleId_idx" ON "PayrollScheduleAssignment"("scheduleId");
CREATE INDEX "PayrollScheduleAssignment_tenantId_idx" ON "PayrollScheduleAssignment"("tenantId");
-- One schedule per person per day: no two assignments of a person overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "PayrollScheduleAssignment" ADD CONSTRAINT "PayrollScheduleAssignment_no_overlap"
  EXCLUDE USING gist ("associateId" WITH =, daterange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::date), '[]') WITH &&);

CREATE TABLE "PayrollScheduleVersion" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"          UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "scheduleId"        UUID NOT NULL,
  "effectiveFrom"     DATE NOT NULL,
  "frequency"         "PayrollFrequency" NOT NULL,
  "anchorDate"        DATE NOT NULL,
  "payDateOffsetDays" INTEGER NOT NULL,
  "createdById"       UUID,
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PayrollScheduleVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollScheduleVersion_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "PayrollSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PayrollScheduleVersion_scheduleId_effectiveFrom_key" ON "PayrollScheduleVersion"("scheduleId", "effectiveFrom");
CREATE INDEX "PayrollScheduleVersion_tenantId_idx" ON "PayrollScheduleVersion"("tenantId");

ALTER TABLE "PayrollSchedule" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "PayrollSchedule_one_default_per_tenant" ON "PayrollSchedule"("tenantId") WHERE "isDefault" AND "deletedAt" IS NULL;

ALTER TABLE "PayrollRun" ADD COLUMN "payrollScheduleId" UUID;
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_payrollScheduleId_fkey" FOREIGN KEY ("payrollScheduleId") REFERENCES "PayrollSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "PayrollRun_payrollScheduleId_periodStart_idx" ON "PayrollRun"("payrollScheduleId", "periodStart");

-- Backfill: every schedule's pattern as its first version; every person
-- already on a schedule as an individual rule and an assignment.
INSERT INTO "PayrollScheduleVersion" ("tenantId", "scheduleId", "effectiveFrom", "frequency", "anchorDate", "payDateOffsetDays", "createdAt")
SELECT s."tenantId", s."id", LEAST(s."anchorDate", s."createdAt"::date), s."frequency", s."anchorDate", s."payDateOffsetDays", s."createdAt"
FROM "PayrollSchedule" s;

INSERT INTO "PayrollScheduleRule" ("tenantId", "scheduleId", "kind", "associateId", "effectiveFrom", "note", "createdAt")
SELECT a."tenantId", a."payrollScheduleId", 'INDIVIDUAL', a."id", LEAST(s."anchorDate", s."createdAt"::date), 'Carried over from the earlier assignment', now()
FROM "Associate" a JOIN "PayrollSchedule" s ON s."id" = a."payrollScheduleId"
WHERE a."payrollScheduleId" IS NOT NULL AND a."deletedAt" IS NULL;

INSERT INTO "PayrollScheduleAssignment" ("tenantId", "associateId", "scheduleId", "effectiveFrom", "source", "ruleId", "reason")
SELECT r."tenantId", r."associateId", r."scheduleId", r."effectiveFrom", 'MIGRATION', r."id", 'Carried over from the earlier assignment'
FROM "PayrollScheduleRule" r WHERE r."kind" = 'INDIVIDUAL';
