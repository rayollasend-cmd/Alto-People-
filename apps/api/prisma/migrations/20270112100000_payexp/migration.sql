-- PAYEXP: daily / next-day pay, manual checks, third-party sick pay,
-- "check my pay before payday", and the bonus gross-up record.

-- Daily pay: a schedule can pay daily (weekly true-up), a run can be a
-- daily settlement or a manual check, and the true-up shows what was paid
-- ahead as its own line.
ALTER TYPE "PayrollFrequency" ADD VALUE IF NOT EXISTS 'DAILY';
ALTER TYPE "PayrollRunKind" ADD VALUE IF NOT EXISTS 'DAILY';
ALTER TYPE "PayrollRunKind" ADD VALUE IF NOT EXISTS 'MANUAL';
ALTER TYPE "PayrollEarningKind" ADD VALUE IF NOT EXISTS 'DAILY_SETTLED';
ALTER TYPE "ApprovalRequestKind" ADD VALUE IF NOT EXISTS 'DAILY_PAY_POLICY';

-- One policy per organization: off until Finance asks and a second person approves.
CREATE TABLE "DailyPayPolicy" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"       UUID         DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "status"         VARCHAR(12)  NOT NULL DEFAULT 'OFF',
  "timing"         VARCHAR(12)  NOT NULL DEFAULT 'NEXT_DAY',
  "eligibility"    VARCHAR(12)  NOT NULL DEFAULT 'ENROLLED',
  "feeCents"       INTEGER      NOT NULL DEFAULT 0,
  "dailyCapCents"  INTEGER      NOT NULL DEFAULT 50000,
  "pending"        JSONB,
  "approvalId"     UUID,
  "requestedById"  UUID,
  "approvedById"   UUID,
  "approvedAt"     TIMESTAMPTZ(6),
  "lastRunAt"      TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "DailyPayPolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailyPayPolicy_tenantId_key" ON "DailyPayPolicy"("tenantId");

-- Who is paid daily (besides everyone on a DAILY schedule).
CREATE TABLE "DailyPayEnrollment" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     UUID         DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"  UUID         NOT NULL,
  "enrolledById" UUID,
  "enrolledAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "endedAt"      TIMESTAMPTZ(6),
  CONSTRAINT "DailyPayEnrollment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyPayEnrollment_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DailyPayEnrollment_associateId_key" ON "DailyPayEnrollment"("associateId");
CREATE INDEX "DailyPayEnrollment_tenantId_idx" ON "DailyPayEnrollment"("tenantId");

-- What each time entry was paid ahead, with its share of the taxes, so the
-- regular check can subtract exactly that — and only once.
CREATE TABLE "DailyPaidTimeEntry" (
  "id"               UUID          NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID          DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "timeEntryId"      UUID          NOT NULL,
  "payrollItemId"    UUID          NOT NULL,
  "associateId"      UUID          NOT NULL,
  "workDate"         DATE          NOT NULL,
  "hours"            DECIMAL(8,2)  NOT NULL DEFAULT 0,
  "gross"            DECIMAL(12,2) NOT NULL DEFAULT 0,
  "federal"          DECIMAL(12,2) NOT NULL DEFAULT 0,
  "fica"             DECIMAL(12,2) NOT NULL DEFAULT 0,
  "medicare"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  "state"            DECIMAL(12,2) NOT NULL DEFAULT 0,
  "local"            DECIMAL(12,2) NOT NULL DEFAULT 0,
  "employerFica"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "employerMedicare" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "employerFuta"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "employerSuta"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "net"              DECIMAL(12,2) NOT NULL DEFAULT 0,
  "reconciledRunId"  UUID,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "DailyPaidTimeEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyPaidTimeEntry_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DailyPaidTimeEntry_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DailyPaidTimeEntry_timeEntryId_key" ON "DailyPaidTimeEntry"("timeEntryId");
CREATE INDEX "DailyPaidTimeEntry_associateId_workDate_idx" ON "DailyPaidTimeEntry"("associateId", "workDate");
CREATE INDEX "DailyPaidTimeEntry_payrollItemId_idx" ON "DailyPaidTimeEntry"("payrollItemId");
CREATE INDEX "DailyPaidTimeEntry_tenantId_idx" ON "DailyPaidTimeEntry"("tenantId");

-- Insurer-paid sick pay, recorded so the W-2 is right (Box 13, Box 12 J).
CREATE TABLE "ThirdPartySickPay" (
  "id"                    UUID          NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"              UUID          DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"           UUID          NOT NULL,
  "payerName"             VARCHAR(200)  NOT NULL,
  "payDate"               DATE          NOT NULL,
  "grossAmount"           DECIMAL(12,2) NOT NULL,
  "nontaxableAmount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "federalWithheld"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  "socialSecurityWithheld" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "medicareWithheld"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "stateWithheld"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  "employerTaxesBy"       VARCHAR(12)   NOT NULL DEFAULT 'EMPLOYER',
  "w2ReportedBy"          VARCHAR(12)   NOT NULL DEFAULT 'EMPLOYER',
  "notes"                 VARCHAR(500),
  "recordedById"          UUID,
  "voidedAt"              TIMESTAMPTZ(6),
  "createdAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ThirdPartySickPay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ThirdPartySickPay_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ThirdPartySickPay_associateId_payDate_idx" ON "ThirdPartySickPay"("associateId", "payDate");
CREATE INDEX "ThirdPartySickPay_tenantId_idx" ON "ThirdPartySickPay"("tenantId");

-- "Check my pay before payday": the worker's answer for one pay date.
CREATE TABLE "PayPreviewCheck" (
  "id"           UUID          NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     UUID          DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"  UUID          NOT NULL,
  "payDate"      DATE          NOT NULL,
  "periodStart"  DATE          NOT NULL,
  "periodEnd"    DATE          NOT NULL,
  "status"       VARCHAR(12)   NOT NULL,
  "estimateNet"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  "flags"        JSONB         NOT NULL DEFAULT '[]',
  "resolvedAt"   TIMESTAMPTZ(6),
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PayPreviewCheck_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayPreviewCheck_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PayPreviewCheck_associateId_payDate_key" ON "PayPreviewCheck"("associateId", "payDate");
CREATE INDEX "PayPreviewCheck_tenantId_payDate_idx" ON "PayPreviewCheck"("tenantId", "payDate");

-- Gross-up: the take-home a bonus line was solved for, and how.
ALTER TABLE "PayrollRunAddOn" ADD COLUMN "targetNet" DECIMAL(12,2);
ALTER TABLE "PayrollRunAddOn" ADD COLUMN "grossUp" JSONB;
