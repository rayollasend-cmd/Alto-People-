-- DEDUCT: garnishments end to end (e-IWO intake and acknowledgments, state
-- allocation rules, IRS levy exempt amounts, electronic remittance), 401(k)
-- recordkeeper integrations, and EDI 834 benefits carrier feeds.

-- ---------------------------------------------------------------- orders
ALTER TABLE "Garnishment"
  ADD COLUMN "state"                      VARCHAR(2),
  ADD COLUMN "fipsCode"                   VARCHAR(7),
  ADD COLUMN "orderIdentifier"            VARCHAR(40),
  ADD COLUMN "remittanceIdentifier"       VARCHAR(40),
  ADD COLUMN "orderFrequency"             VARCHAR(12),
  ADD COLUMN "currentSupport"             DECIMAL(10,2),
  ADD COLUMN "pastDueSupport"             DECIMAL(10,2),
  ADD COLUMN "medicalSupport"             DECIMAL(10,2),
  ADD COLUMN "arrearsOver12Weeks"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "supportsSecondFamily"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "adminFee"                   DECIMAL(8,2),
  ADD COLUMN "levyFilingStatus"           VARCHAR(24),
  ADD COLUMN "levyExemptions"             INTEGER,
  ADD COLUMN "levyAdditionalStandard"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "levyTaxYear"                INTEGER,
  ADD COLUMN "source"                     VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "receivedAt"                 TIMESTAMPTZ(6),
  ADD COLUMN "payeeKind"                  VARCHAR(12),
  ADD COLUMN "remitMethod"                VARCHAR(12) NOT NULL DEFAULT 'CHECK',
  ADD COLUMN "payeeRoutingEnc"            TEXT,
  ADD COLUMN "payeeAccountEnc"            TEXT,
  ADD COLUMN "payeeAccountLast4"          VARCHAR(4),
  ADD COLUMN "lumpSumReporting"           BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "GarnishmentDeduction" ADD COLUMN "adminFee" DECIMAL(8,2) NOT NULL DEFAULT 0;

ALTER TABLE "GarnishmentRemittance"
  ADD COLUMN "method"    VARCHAR(12) NOT NULL DEFAULT 'CHECK',
  ADD COLUMN "fileId"    UUID,
  ADD COLUMN "advice"    TEXT;

-- The electronic Income Withholding Order as received, and what we answered.
CREATE TABLE "EiwoDocument" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"             UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "receivedAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "documentActionCode"   VARCHAR(4) NOT NULL,
  "caseIdentifier"       VARCHAR(40),
  "orderIdentifier"      VARCHAR(40),
  "remittanceIdentifier" VARCHAR(40),
  "issuingState"         VARCHAR(2),
  "employeeName"         VARCHAR(120),
  "employeeSsnLast4"     VARCHAR(4),
  "rawContent"           TEXT NOT NULL,
  "parsed"               JSONB NOT NULL,
  "status"               VARCHAR(12) NOT NULL DEFAULT 'RECEIVED',
  "rejectReasonCode"     VARCHAR(4),
  "rejectReason"         VARCHAR(500),
  "associateId"          UUID,
  "garnishmentId"        UUID,
  "ackContent"           TEXT,
  "ackGeneratedAt"       TIMESTAMPTZ(6),
  "decidedById"          UUID,
  "createdAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "EiwoDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EiwoDocument_tenantId_status_idx" ON "EiwoDocument"("tenantId", "status");
CREATE INDEX "EiwoDocument_garnishmentId_idx" ON "EiwoDocument"("garnishmentId");

-- Employer → state notices: employment ended, or a lump sum is about to be paid.
CREATE TABLE "EiwoNotice" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "garnishmentId" UUID NOT NULL,
  "kind"          VARCHAR(16) NOT NULL,
  "content"       TEXT NOT NULL,
  "payload"       JSONB NOT NULL,
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "sentAt"        TIMESTAMPTZ(6),
  "reference"     VARCHAR(80),
  CONSTRAINT "EiwoNotice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EiwoNotice_garnishmentId_idx" ON "EiwoNotice"("garnishmentId");
CREATE INDEX "EiwoNotice_tenantId_idx" ON "EiwoNotice"("tenantId");

-- How a state splits several support orders, and what it lets an employer charge.
CREATE TABLE "GarnishmentStateRule" (
  "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"                 UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "state"                    VARCHAR(2) NOT NULL,
  "allocationMethod"         VARCHAR(16) NOT NULL DEFAULT 'PRO_RATA',
  "supportMaxPercent"        DECIMAL(5,4),
  "creditorMaxPercent"       DECIMAL(5,4),
  "adminFeeMax"              DECIMAL(8,2),
  "adminFeeFrequency"        VARCHAR(12),
  "notes"                    VARCHAR(500),
  "updatedById"              UUID,
  "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "GarnishmentStateRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GarnishmentStateRule_tenantId_state_key" ON "GarnishmentStateRule"("tenantId", "state");

-- IRS Publication 1494 inputs per tax year (entered from the publication).
CREATE TABLE "LevyExemptParameter" (
  "id"                         UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"                   UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "taxYear"                    INTEGER NOT NULL,
  "filingStatus"               VARCHAR(24) NOT NULL,
  "standardDeduction"          DECIMAL(10,2) NOT NULL,
  "additionalStandardDeduction" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "exemptionAmount"            DECIMAL(10,2) NOT NULL,
  "source"                     VARCHAR(200),
  "updatedById"                UUID,
  "createdAt"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "LevyExemptParameter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LevyExemptParameter_tenantId_taxYear_filingStatus_key" ON "LevyExemptParameter"("tenantId", "taxYear", "filingStatus");

-- --------------------------------------------------------- retirement
CREATE TABLE "RetirementPlan" (
  "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"               UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "employerId"             UUID,
  "name"                   VARCHAR(120) NOT NULL,
  "planNumber"             VARCHAR(40),
  "recordkeeper"           VARCHAR(20) NOT NULL,
  "connectionEnc"          TEXT,
  "status"                 VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  "establishedOn"          DATE,
  "eligibilityMinAge"      INTEGER NOT NULL DEFAULT 21,
  "eligibilityServiceDays" INTEGER NOT NULL DEFAULT 0,
  "entryTiming"            VARCHAR(12) NOT NULL DEFAULT 'IMMEDIATE',
  "autoEnroll"             BOOLEAN NOT NULL DEFAULT false,
  "autoEnrollPercent"      DECIMAL(5,2) NOT NULL DEFAULT 0,
  "autoEscalatePercent"    DECIMAL(5,2) NOT NULL DEFAULT 0,
  "autoEscalateMax"        DECIMAL(5,2) NOT NULL DEFAULT 0,
  "optOutDays"             INTEGER NOT NULL DEFAULT 90,
  "matchFormula"           JSONB NOT NULL DEFAULT '[]',
  "safeHarbor"             VARCHAR(16) NOT NULL DEFAULT 'NONE',
  "rothEnabled"            BOOLEAN NOT NULL DEFAULT true,
  "catchUpEnabled"         BOOLEAN NOT NULL DEFAULT true,
  "createdById"            UUID,
  "createdAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "RetirementPlan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RetirementPlan_tenantId_idx" ON "RetirementPlan"("tenantId");

CREATE TABLE "RetirementElection" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"        UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "planId"          UUID NOT NULL,
  "associateId"     UUID NOT NULL,
  "status"          VARCHAR(16) NOT NULL,
  "preTaxPercent"   DECIMAL(5,2) NOT NULL DEFAULT 0,
  "rothPercent"     DECIMAL(5,2) NOT NULL DEFAULT 0,
  "eligibleOn"      DATE,
  "enrolledOn"      DATE,
  "optOutDeadline"  DATE,
  "nextEscalationOn" DATE,
  "source"          VARCHAR(16) NOT NULL DEFAULT 'EMPLOYEE',
  "updatedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "RetirementElection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RetirementElection_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RetirementPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RetirementElection_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RetirementElection_planId_associateId_key" ON "RetirementElection"("planId", "associateId");
CREATE INDEX "RetirementElection_tenantId_idx" ON "RetirementElection"("tenantId");

CREATE TABLE "RetirementLoan" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "planId"        UUID NOT NULL,
  "associateId"   UUID NOT NULL,
  "loanNumber"    VARCHAR(40) NOT NULL,
  "perPayAmount"  DECIMAL(10,2) NOT NULL,
  "startDate"     DATE NOT NULL,
  "endDate"       DATE,
  "balance"       DECIMAL(12,2),
  "status"        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "RetirementLoan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RetirementLoan_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RetirementPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RetirementLoan_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RetirementLoan_planId_loanNumber_key" ON "RetirementLoan"("planId", "loanNumber");
CREATE INDEX "RetirementLoan_tenantId_idx" ON "RetirementLoan"("tenantId");

-- What each paycheck sent to the plan, by source — the contribution file's rows.
CREATE TABLE "RetirementContribution" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"       UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "planId"         UUID NOT NULL,
  "associateId"    UUID NOT NULL,
  "payrollRunId"   UUID NOT NULL,
  "payrollItemId"  UUID,
  "payDate"        DATE NOT NULL,
  "eligibleComp"   DECIMAL(12,2) NOT NULL DEFAULT 0,
  "preTax"         DECIMAL(10,2) NOT NULL DEFAULT 0,
  "roth"           DECIMAL(10,2) NOT NULL DEFAULT 0,
  "catchUpPreTax"  DECIMAL(10,2) NOT NULL DEFAULT 0,
  "catchUpRoth"    DECIMAL(10,2) NOT NULL DEFAULT 0,
  "employerMatch"  DECIMAL(10,2) NOT NULL DEFAULT 0,
  "safeHarbor"     DECIMAL(10,2) NOT NULL DEFAULT 0,
  "loanRepayments" JSONB NOT NULL DEFAULT '[]',
  "fileId"         UUID,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "RetirementContribution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RetirementContribution_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RetirementPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RetirementContribution_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RetirementContribution_payrollRunId_planId_associateId_key" ON "RetirementContribution"("payrollRunId", "planId", "associateId");
CREATE INDEX "RetirementContribution_associateId_payDate_idx" ON "RetirementContribution"("associateId", "payDate");
CREATE INDEX "RetirementContribution_tenantId_idx" ON "RetirementContribution"("tenantId");

CREATE TABLE "RetirementFile" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "planId"        UUID NOT NULL,
  "kind"          VARCHAR(16) NOT NULL,
  "payrollRunId"  UUID,
  "payDate"       DATE,
  "format"        VARCHAR(24) NOT NULL,
  "content"       TEXT NOT NULL,
  "rowCount"      INTEGER NOT NULL DEFAULT 0,
  "totals"        JSONB NOT NULL DEFAULT '{}',
  "status"        VARCHAR(12) NOT NULL DEFAULT 'GENERATED',
  "error"         VARCHAR(1000),
  "sentAt"        TIMESTAMPTZ(6),
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "RetirementFile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RetirementFile_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RetirementPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RetirementFile_planId_createdAt_idx" ON "RetirementFile"("planId", "createdAt");
CREATE INDEX "RetirementFile_tenantId_idx" ON "RetirementFile"("tenantId");

-- ------------------------------------------------------- carrier feeds
CREATE TABLE "BenefitCarrier" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"        UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "name"            VARCHAR(120) NOT NULL,
  "receiverId"      VARCHAR(15) NOT NULL,
  "receiverQualifier" VARCHAR(2) NOT NULL DEFAULT 'ZZ',
  "senderId"        VARCHAR(15) NOT NULL,
  "senderQualifier" VARCHAR(2) NOT NULL DEFAULT 'ZZ',
  "sponsorTaxId"    VARCHAR(9),
  "policyNumber"    VARCHAR(50),
  "usageIndicator"  VARCHAR(1) NOT NULL DEFAULT 'T',
  "transport"       VARCHAR(12) NOT NULL DEFAULT 'DOWNLOAD',
  "connectionEnc"   TEXT,
  "lastControlNumber" INTEGER NOT NULL DEFAULT 0,
  "active"          BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "BenefitCarrier_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BenefitCarrier_tenantId_idx" ON "BenefitCarrier"("tenantId");

ALTER TABLE "BenefitsPlan"
  ADD COLUMN "carrierId"         UUID,
  ADD COLUMN "insuranceLineCode" VARCHAR(3),
  ADD COLUMN "carrierPlanCode"   VARCHAR(50);
CREATE INDEX "BenefitsPlan_carrierId_idx" ON "BenefitsPlan"("carrierId");

ALTER TABLE "BenefitsEnrollment"
  ADD COLUMN "coverageLevel" VARCHAR(3) NOT NULL DEFAULT 'EMP',
  ADD COLUMN "coveredDependentIds" UUID[] NOT NULL DEFAULT '{}';

CREATE TABLE "Edi834File" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "carrierId"     UUID NOT NULL,
  "mode"          VARCHAR(8) NOT NULL,
  "controlNumber" INTEGER NOT NULL,
  "content"       TEXT NOT NULL,
  "memberCount"   INTEGER NOT NULL DEFAULT 0,
  "status"        VARCHAR(12) NOT NULL DEFAULT 'GENERATED',
  "error"         VARCHAR(1000),
  "sentAt"        TIMESTAMPTZ(6),
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "Edi834File_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Edi834File_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "BenefitCarrier"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Edi834File_carrierId_createdAt_idx" ON "Edi834File"("carrierId", "createdAt");
CREATE INDEX "Edi834File_tenantId_idx" ON "Edi834File"("tenantId");

-- Per-tenant overrides of the federal annual limits (the defaults live in code, cited).
CREATE TABLE "BenefitLimitOverride" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "taxYear"     INTEGER NOT NULL,
  "code"        VARCHAR(40) NOT NULL,
  "amount"      DECIMAL(12,2) NOT NULL,
  "updatedById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "BenefitLimitOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BenefitLimitOverride_tenantId_taxYear_code_key" ON "BenefitLimitOverride"("tenantId", "taxYear", "code");
