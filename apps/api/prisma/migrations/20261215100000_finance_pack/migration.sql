-- Pay & finance pack (2026-10-17): retroactive pay, returned-deposit
-- reroute, invoicing terms with a dunning cadence, GL by cost center,
-- 1095-C / 1094-C forms with filing confirmations, time-off policies, and
-- earned-wage access.

-- Retroactive pay is its own earning line on the paystub.
ALTER TYPE "PayrollEarningKind" ADD VALUE IF NOT EXISTS 'RETRO';

-- ACA forms join the tax-form register.
ALTER TYPE "TaxFormKind" ADD VALUE IF NOT EXISTS 'F1095C';
ALTER TYPE "TaxFormKind" ADD VALUE IF NOT EXISTS 'F1094C';

-- The agency / partner acknowledgment keyed in when a form is marked filed.
ALTER TABLE "TaxForm" ADD COLUMN "filingConfirmation" VARCHAR(80);

-- A deposit the bank returned, and the re-send that followed.
ALTER TABLE "PayrollItem" ADD COLUMN "returnedAt" TIMESTAMPTZ(6);
ALTER TABLE "PayrollItem" ADD COLUMN "reroutedAt" TIMESTAMPTZ(6);
ALTER TABLE "PayrollItem" ADD COLUMN "rerouteDetail" JSONB;

-- Retroactive pay: one row per (comp record, paid item) pair, paid once.
CREATE TYPE "RetroPayStatus" AS ENUM ('PENDING', 'PAID');

CREATE TABLE "RetroPayAdjustment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "compensationRecordId" UUID NOT NULL,
  "sourcePayrollItemId" UUID NOT NULL,
  "regularHours" DECIMAL(8,2) NOT NULL,
  "overtimeHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "oldRate" DECIMAL(8,2) NOT NULL,
  "newRate" DECIMAL(8,2) NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "status" "RetroPayStatus" NOT NULL DEFAULT 'PENDING',
  "paidRunId" UUID,
  "paidItemId" UUID,
  "paidAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "RetroPayAdjustment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RetroPayAdjustment_compensationRecordId_sourcePayrollItemId_key" ON "RetroPayAdjustment"("compensationRecordId", "sourcePayrollItemId");
CREATE INDEX "RetroPayAdjustment_associateId_status_idx" ON "RetroPayAdjustment"("associateId", "status");
CREATE INDEX "RetroPayAdjustment_paidRunId_idx" ON "RetroPayAdjustment"("paidRunId");
CREATE INDEX "RetroPayAdjustment_tenantId_idx" ON "RetroPayAdjustment"("tenantId");
ALTER TABLE "RetroPayAdjustment" ADD CONSTRAINT "RetroPayAdjustment_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetroPayAdjustment" ADD CONSTRAINT "RetroPayAdjustment_compensationRecordId_fkey" FOREIGN KEY ("compensationRecordId") REFERENCES "CompensationRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetroPayAdjustment" ADD CONSTRAINT "RetroPayAdjustment_sourcePayrollItemId_fkey" FOREIGN KEY ("sourcePayrollItemId") REFERENCES "PayrollItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetroPayAdjustment" ADD CONSTRAINT "RetroPayAdjustment_paidRunId_fkey" FOREIGN KEY ("paidRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RetroPayAdjustment" ADD CONSTRAINT "RetroPayAdjustment_paidItemId_fkey" FOREIGN KEY ("paidItemId") REFERENCES "PayrollItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Earned-wage access.
CREATE TYPE "EarnedWageAdvanceStatus" AS ENUM ('REQUESTED', 'PAID', 'FAILED', 'RECOVERED', 'CANCELLED');

CREATE TABLE "EarnedWageAdvance" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "feeCents" INTEGER NOT NULL DEFAULT 0,
  "earnedNetCents" INTEGER NOT NULL,
  "availableCents" INTEGER NOT NULL,
  "status" "EarnedWageAdvanceStatus" NOT NULL DEFAULT 'REQUESTED',
  "provider" TEXT,
  "disbursementRef" TEXT,
  "failureReason" TEXT,
  "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMPTZ(6),
  "recoveredCents" INTEGER NOT NULL DEFAULT 0,
  "recoveredRunId" UUID,
  "recoveredItemId" UUID,
  "recoveredAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "EarnedWageAdvance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EarnedWageAdvance_amount_positive_chk" CHECK ("amountCents" > 0)
);
CREATE INDEX "EarnedWageAdvance_associateId_status_idx" ON "EarnedWageAdvance"("associateId", "status");
CREATE INDEX "EarnedWageAdvance_status_requestedAt_idx" ON "EarnedWageAdvance"("status", "requestedAt");
CREATE INDEX "EarnedWageAdvance_tenantId_idx" ON "EarnedWageAdvance"("tenantId");
ALTER TABLE "EarnedWageAdvance" ADD CONSTRAINT "EarnedWageAdvance_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EarnedWageAdvance" ADD CONSTRAINT "EarnedWageAdvance_recoveredRunId_fkey" FOREIGN KEY ("recoveredRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EarnedWageAdvance" ADD CONSTRAINT "EarnedWageAdvance_recoveredItemId_fkey" FOREIGN KEY ("recoveredItemId") REFERENCES "PayrollItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrgSetting" ADD COLUMN "ewaEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "OrgSetting" ADD COLUMN "ewaCapPct" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "OrgSetting" ADD COLUMN "ewaFeeCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrgSetting" ADD COLUMN "ewaMaxPerPeriodCents" INTEGER NOT NULL DEFAULT 100000;

-- Invoicing: PO numbers, credit terms, and the dunning cadence.
ALTER TABLE "Client" ADD COLUMN "poNumber" VARCHAR(60);
ALTER TABLE "Client" ADD COLUMN "paymentTermsDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Client" ADD COLUMN "dunningPausedAt" TIMESTAMPTZ(6);
ALTER TABLE "Client" ADD COLUMN "dunningPausedById" UUID;
ALTER TABLE "Client" ADD COLUMN "dunningPauseNote" TEXT;

ALTER TABLE "ClientStatement" ADD COLUMN "poNumber" VARCHAR(60);
ALTER TABLE "ClientStatement" ADD COLUMN "dueAt" DATE;
ALTER TABLE "ClientStatement" ADD COLUMN "reminderStage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ClientStatement" ADD COLUMN "lastReminderAt" TIMESTAMPTZ(6);
CREATE INDEX "ClientStatement_status_dueAt_idx" ON "ClientStatement"("status", "dueAt");
-- Statements already final fall due on the client's terms from the day they were finalized.
UPDATE "ClientStatement" s
SET "dueAt" = (s."finalizedAt" AT TIME ZONE 'UTC')::date + c."paymentTermsDays"
FROM "Client" c
WHERE c.id = s."clientId" AND s.status = 'FINAL' AND s."finalizedAt" IS NOT NULL AND s."dueAt" IS NULL;

CREATE TABLE "ClientStatementReminder" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "statementId" UUID NOT NULL,
  "stage" INTEGER NOT NULL,
  "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recipients" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ClientStatementReminder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientStatementReminder_statementId_stage_key" ON "ClientStatementReminder"("statementId", "stage");
CREATE INDEX "ClientStatementReminder_tenantId_idx" ON "ClientStatementReminder"("tenantId");
ALTER TABLE "ClientStatementReminder" ADD CONSTRAINT "ClientStatementReminder_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "ClientStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- GL by cost center.
ALTER TABLE "QuickbooksConnection" ADD COLUMN "glByCostCenter" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "QuickbooksCostCenterMapping" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "connectionId" UUID NOT NULL,
  "costCenterId" UUID NOT NULL,
  "accountRef" VARCHAR(64) NOT NULL,
  "accountName" VARCHAR(120),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "QuickbooksCostCenterMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuickbooksCostCenterMapping_connectionId_costCenterId_key" ON "QuickbooksCostCenterMapping"("connectionId", "costCenterId");
CREATE INDEX "QuickbooksCostCenterMapping_tenantId_idx" ON "QuickbooksCostCenterMapping"("tenantId");
ALTER TABLE "QuickbooksCostCenterMapping" ADD CONSTRAINT "QuickbooksCostCenterMapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "QuickbooksConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuickbooksCostCenterMapping" ADD CONSTRAINT "QuickbooksCostCenterMapping_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Time-off policies.
CREATE TYPE "TimeOffAccrualMode" AS ENUM ('PER_HOUR_WORKED', 'PER_PERIOD', 'ANNUAL_GRANT');
CREATE TYPE "TimeOffPolicyScope" AS ENUM ('ALL', 'CLIENT', 'SITE', 'DEPARTMENT', 'JOB_PROFILE');

CREATE TABLE "TimeOffPolicy" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "name" VARCHAR(120) NOT NULL,
  "category" "TimeOffCategory" NOT NULL,
  "accrualMode" "TimeOffAccrualMode" NOT NULL,
  "accrualPerHour" DECIMAL(8,5),
  "minutesPerPeriod" INTEGER,
  "annualMinutes" INTEGER,
  "policyAnchorDate" DATE NOT NULL DEFAULT DATE '2000-01-01',
  "capMinutes" INTEGER,
  "carryoverMaxMinutes" INTEGER NOT NULL DEFAULT 0,
  "waitingPeriodDays" INTEGER NOT NULL DEFAULT 0,
  "tenureTiers" JSONB NOT NULL DEFAULT '[]',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "TimeOffPolicy_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimeOffPolicy_tenantId_category_idx" ON "TimeOffPolicy"("tenantId", "category");

CREATE TABLE "TimeOffPolicyAssignment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "policyId" UUID NOT NULL,
  "scopeKind" "TimeOffPolicyScope" NOT NULL,
  "scopeId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeOffPolicyAssignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimeOffPolicyAssignment_policyId_idx" ON "TimeOffPolicyAssignment"("policyId");
CREATE INDEX "TimeOffPolicyAssignment_scopeKind_scopeId_idx" ON "TimeOffPolicyAssignment"("scopeKind", "scopeId");
CREATE INDEX "TimeOffPolicyAssignment_tenantId_idx" ON "TimeOffPolicyAssignment"("tenantId");
ALTER TABLE "TimeOffPolicyAssignment" ADD CONSTRAINT "TimeOffPolicyAssignment_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "TimeOffPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimeOffEntitlement" ADD COLUMN "policyId" UUID;
CREATE INDEX "TimeOffEntitlement_policyId_idx" ON "TimeOffEntitlement"("policyId");
ALTER TABLE "TimeOffEntitlement" ADD CONSTRAINT "TimeOffEntitlement_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "TimeOffPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TimeOffLedgerEntry" ADD COLUMN "sourcePolicyId" UUID;
ALTER TABLE "TimeOffLedgerEntry" ADD COLUMN "periodKey" VARCHAR(7);
CREATE UNIQUE INDEX "uniq_period_grant" ON "TimeOffLedgerEntry"("associateId", "sourcePolicyId", "periodKey");

-- Every annual grant already on file becomes a policy: one per distinct
-- (tenant, category, annual minutes, carryover, anchor), named after what
-- it grants, assigned to no one automatically. The people on it keep their
-- balances exactly as they are — only the link is added.
INSERT INTO "TimeOffPolicy" ("tenantId", "name", "category", "accrualMode", "annualMinutes", "carryoverMaxMinutes", "policyAnchorDate", "notes", "updatedAt")
SELECT DISTINCT
  e."tenantId",
  initcap(lower(e.category::text)) || ' — ' || round(e."annualMinutes" / 60.0, 1)::text || ' h a year' ||
    CASE WHEN e."carryoverMaxMinutes" > 0 THEN ', carry over ' || round(e."carryoverMaxMinutes" / 60.0, 1)::text || ' h' ELSE '' END,
  e.category,
  'ANNUAL_GRANT'::"TimeOffAccrualMode",
  e."annualMinutes",
  e."carryoverMaxMinutes",
  e."policyAnchorDate",
  'Created from the annual grants on file when time-off policies arrived.',
  CURRENT_TIMESTAMP
FROM "TimeOffEntitlement" e;

UPDATE "TimeOffEntitlement" e
SET "policyId" = p.id
FROM "TimeOffPolicy" p
WHERE e."policyId" IS NULL
  AND p."accrualMode" = 'ANNUAL_GRANT'
  AND p.category = e.category
  AND p."annualMinutes" = e."annualMinutes"
  AND p."carryoverMaxMinutes" = e."carryoverMaxMinutes"
  AND p."policyAnchorDate" = e."policyAnchorDate"
  AND (p."tenantId" = e."tenantId" OR (p."tenantId" IS NULL AND e."tenantId" IS NULL));
