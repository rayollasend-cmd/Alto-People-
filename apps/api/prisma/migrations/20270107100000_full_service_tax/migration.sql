-- Full-service payroll tax: agency accounts, the liability ledger, payments,
-- returns and agency notices; an embedded payroll provider as a connection kind.

ALTER TYPE "ProviderKind" ADD VALUE IF NOT EXISTS 'EMBEDDED_PAYROLL';

CREATE TYPE "TaxAgencyKind" AS ENUM ('FEDERAL_WITHHOLDING', 'FEDERAL_UNEMPLOYMENT', 'STATE_WITHHOLDING', 'STATE_UNEMPLOYMENT', 'LOCAL');
CREATE TYPE "TaxLiabilityStatus" AS ENUM ('OPEN', 'SCHEDULED', 'PAID', 'VOID');
CREATE TYPE "TaxPaymentStatus" AS ENUM ('SCHEDULED', 'SUBMITTED', 'PAID', 'FAILED', 'CANCELLED');
CREATE TYPE "TaxReturnStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'FILED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');
CREATE TYPE "AgencyNoticeStatus" AS ENUM ('NEW', 'IN_REVIEW', 'RESPONDED', 'RESOLVED');

CREATE TABLE "TaxAgencyAccount" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "employerOrgId" UUID,
  "kind" "TaxAgencyKind" NOT NULL,
  "jurisdiction" VARCHAR(80) NOT NULL,
  "agencyName" VARCHAR(160) NOT NULL,
  "accountNumber" VARCHAR(60),
  "depositFrequency" VARCHAR(16) NOT NULL DEFAULT 'MONTHLY',
  "dueDayOfMonth" INTEGER NOT NULL DEFAULT 15,
  "rate" DECIMAL(7,5),
  "rateYear" INTEGER,
  "wageBase" DECIMAL(12,2),
  "status" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  "effectiveFrom" DATE,
  "effectiveTo" DATE,
  "notes" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TaxAgencyAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TaxAgencyAccount_tenantId_kind_jurisdiction_idx" ON "TaxAgencyAccount"("tenantId", "kind", "jurisdiction");
ALTER TABLE "TaxAgencyAccount" ADD CONSTRAINT "TaxAgencyAccount_employerOrgId_fkey" FOREIGN KEY ("employerOrgId") REFERENCES "EmployerOrganization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TaxPayment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "accountId" UUID,
  "kind" "TaxAgencyKind" NOT NULL,
  "jurisdiction" VARCHAR(80) NOT NULL,
  "periodLabel" VARCHAR(16) NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "dueDate" DATE NOT NULL,
  "method" VARCHAR(20) NOT NULL,
  "status" "TaxPaymentStatus" NOT NULL DEFAULT 'SCHEDULED',
  "providerConnectionId" UUID,
  "providerRef" VARCHAR(120),
  "confirmationNumber" VARCHAR(80),
  "submittedAt" TIMESTAMPTZ(6),
  "paidAt" TIMESTAMPTZ(6),
  "paidById" UUID,
  "failureReason" VARCHAR(500),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TaxPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TaxPayment_tenantId_status_dueDate_idx" ON "TaxPayment"("tenantId", "status", "dueDate");
ALTER TABLE "TaxPayment" ADD CONSTRAINT "TaxPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TaxAgencyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TaxLiability" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "payrollRunId" UUID,
  "employerOrgId" UUID,
  "accountId" UUID,
  "kind" "TaxAgencyKind" NOT NULL,
  "jurisdiction" VARCHAR(80) NOT NULL,
  "periodLabel" VARCHAR(16) NOT NULL,
  "liabilityDate" DATE NOT NULL,
  "dueDate" DATE NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "breakdown" JSONB NOT NULL DEFAULT '{}',
  "status" "TaxLiabilityStatus" NOT NULL DEFAULT 'OPEN',
  "paymentId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TaxLiability_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TaxLiability_payrollRunId_kind_jurisdiction_key" ON "TaxLiability"("payrollRunId", "kind", "jurisdiction");
CREATE INDEX "TaxLiability_tenantId_status_dueDate_idx" ON "TaxLiability"("tenantId", "status", "dueDate");
CREATE INDEX "TaxLiability_tenantId_periodLabel_idx" ON "TaxLiability"("tenantId", "periodLabel");
ALTER TABLE "TaxLiability" ADD CONSTRAINT "TaxLiability_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaxLiability" ADD CONSTRAINT "TaxLiability_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TaxAgencyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaxLiability" ADD CONSTRAINT "TaxLiability_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "TaxPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TaxReturn" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "accountId" UUID,
  "kind" VARCHAR(30) NOT NULL,
  "jurisdiction" VARCHAR(80) NOT NULL,
  "periodLabel" VARCHAR(16) NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "dueDate" DATE NOT NULL,
  "data" JSONB NOT NULL,
  "status" "TaxReturnStatus" NOT NULL DEFAULT 'DRAFT',
  "method" VARCHAR(20),
  "providerRef" VARCHAR(120),
  "confirmationNumber" VARCHAR(80),
  "filedAt" TIMESTAMPTZ(6),
  "filedById" UUID,
  "rejectionReason" VARCHAR(500),
  "amendsId" UUID,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TaxReturn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TaxReturn_tenantId_kind_periodLabel_idx" ON "TaxReturn"("tenantId", "kind", "periodLabel");
ALTER TABLE "TaxReturn" ADD CONSTRAINT "TaxReturn_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TaxAgencyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaxReturn" ADD CONSTRAINT "TaxReturn_amendsId_fkey" FOREIGN KEY ("amendsId") REFERENCES "TaxReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AgencyNotice" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "accountId" UUID,
  "agencyName" VARCHAR(160) NOT NULL,
  "jurisdiction" VARCHAR(80),
  "noticeType" VARCHAR(80) NOT NULL,
  "noticeNumber" VARCHAR(60),
  "noticeDate" DATE NOT NULL,
  "periodLabel" VARCHAR(16),
  "amountDue" DECIMAL(12,2),
  "responseDueAt" DATE,
  "status" "AgencyNoticeStatus" NOT NULL DEFAULT 'NEW',
  "assignedToId" UUID,
  "fileKey" VARCHAR(300),
  "fileName" VARCHAR(200),
  "contentType" VARCHAR(100),
  "summary" VARCHAR(2000),
  "response" VARCHAR(4000),
  "respondedAt" TIMESTAMPTZ(6),
  "resolution" VARCHAR(2000),
  "resolvedAt" TIMESTAMPTZ(6),
  "penaltyAmount" DECIMAL(12,2),
  "abatedAmount" DECIMAL(12,2),
  "events" JSONB NOT NULL DEFAULT '[]',
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgencyNotice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgencyNotice_tenantId_status_responseDueAt_idx" ON "AgencyNotice"("tenantId", "status", "responseDueAt");
ALTER TABLE "AgencyNotice" ADD CONSTRAINT "AgencyNotice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TaxAgencyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
