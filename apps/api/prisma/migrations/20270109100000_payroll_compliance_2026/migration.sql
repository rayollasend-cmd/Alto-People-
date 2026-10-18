-- Payroll compliance, 2026: the W-2's new Box 12 codes (TP qualified tips,
-- TT qualified overtime, TA Trump account) and Box 14b tipped occupation
-- codes; SECURE 2.0 Roth catch-up and the annual deferral limits; the state
-- pay notices (NY WTPA, CA 2810.5 …) with their acknowledgments; and new-hire
-- reporting with deadlines per state.

-- The Treasury Tipped Occupation Code a job carries (W-2 Box 14b).
ALTER TABLE "JobProfile" ADD COLUMN "tippedOccupationCode" VARCHAR(4);

-- Per paycheck: what the 2026 W-2 reports beside wages.
ALTER TABLE "PayrollItem"
  ADD COLUMN "qualifiedTips" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "qualifiedOvertime" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "tippedOccupationCode" VARCHAR(4),
  ADD COLUMN "deferrals" JSONB;

-- A designated-Roth election on a 401(k)/403(b) enrollment, and whether the
-- plan treats a higher earner's catch-up as Roth automatically (deemed Roth).
ALTER TABLE "BenefitsEnrollment" ADD COLUMN "rothElection" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BenefitsPlan" ADD COLUMN "allowsDeemedRoth" BOOLEAN NOT NULL DEFAULT true;
ALTER TYPE "BenefitsPlanKind" ADD VALUE IF NOT EXISTS 'TRUMP_ACCOUNT';

-- A multistate employer may report every new hire to one state (42 USC 653a(b)(1)(B)).
ALTER TABLE "OrgSetting" ADD COLUMN "newHireMultistateState" VARCHAR(2);

-- A state pay notice owed to a worker (at hire, at a rate change) and its acknowledgment.
CREATE TABLE "WagePayNotice" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "state" VARCHAR(2) NOT NULL,
  "form" VARCHAR(24) NOT NULL,
  "trigger" VARCHAR(16) NOT NULL,
  "language" VARCHAR(8) NOT NULL DEFAULT 'en',
  "facts" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'SENT',
  "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "acknowledgedAt" TIMESTAMPTZ(6),
  "signedName" VARCHAR(200),
  "signatureIp" VARCHAR(64),
  "signatureUserAgent" VARCHAR(300),
  "documentHash" VARCHAR(64),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "WagePayNotice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WagePayNotice_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WagePayNotice_tenantId_status_idx" ON "WagePayNotice"("tenantId", "status");
CREATE INDEX "WagePayNotice_associateId_idx" ON "WagePayNotice"("associateId");

-- One new-hire report owed per hire and reporting state, with its deadline.
CREATE TABLE "NewHireReport" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "state" VARCHAR(2) NOT NULL,
  "hireDate" DATE NOT NULL,
  "dueDate" DATE NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'DUE',
  "method" VARCHAR(16),
  "confirmation" VARCHAR(120),
  "submittedAt" TIMESTAMPTZ(6),
  "submittedById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "NewHireReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NewHireReport_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NewHireReport_associateId_state_hireDate_key" ON "NewHireReport"("associateId", "state", "hireDate");
CREATE INDEX "NewHireReport_tenantId_status_dueDate_idx" ON "NewHireReport"("tenantId", "status", "dueDate");
