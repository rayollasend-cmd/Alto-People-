-- Certified payroll (prevailing wage) and contractors (W-9, TIN matching,
-- B-notices, backup withholding, contractor payment runs, state 1099 filing).

CREATE TABLE "PrevailingWageProject" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "name" VARCHAR(200) NOT NULL,
  "contractNumber" VARCHAR(80),
  "agency" VARCHAR(200),
  "awardingBody" VARCHAR(200),
  "wageDeterminationNumber" VARCHAR(80),
  "dirProjectId" VARCHAR(40),
  "siteId" UUID,
  "clientId" UUID,
  "addressLine1" VARCHAR(200),
  "city" VARCHAR(80),
  "county" VARCHAR(80),
  "state" VARCHAR(2),
  "zip" VARCHAR(10),
  "startDate" DATE NOT NULL,
  "endDate" DATE,
  "weekEndsOn" INTEGER NOT NULL DEFAULT 6,
  "fringeMode" VARCHAR(10) NOT NULL DEFAULT 'CASH',
  "payrollOfficerName" VARCHAR(120),
  "payrollOfficerTitle" VARCHAR(120),
  "status" VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrevailingWageProject_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrevailingWageProject_tenantId_status_idx" ON "PrevailingWageProject"("tenantId", "status");
CREATE INDEX "PrevailingWageProject_siteId_idx" ON "PrevailingWageProject"("siteId");
ALTER TABLE "PrevailingWageProject" ADD CONSTRAINT "PrevailingWageProject_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PrevailingWageRate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "projectId" UUID NOT NULL,
  "classification" VARCHAR(120) NOT NULL,
  "baseRate" DECIMAL(8,2) NOT NULL,
  "fringeRate" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "apprenticesPerJourneyman" DECIMAL(5,2),
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrevailingWageRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrevailingWageRate_projectId_classification_idx" ON "PrevailingWageRate"("projectId", "classification");
CREATE INDEX "PrevailingWageRate_tenantId_idx" ON "PrevailingWageRate"("tenantId");
ALTER TABLE "PrevailingWageRate" ADD CONSTRAINT "PrevailingWageRate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PrevailingWageProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PrevailingWageWorker" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "projectId" UUID NOT NULL,
  "associateId" UUID NOT NULL,
  "classification" VARCHAR(120) NOT NULL,
  "isApprentice" BOOLEAN NOT NULL DEFAULT false,
  "apprenticeRegistration" VARCHAR(80),
  "apprenticeLevelPercent" DECIMAL(5,2),
  "startedOn" DATE NOT NULL,
  "endedOn" DATE,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrevailingWageWorker_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrevailingWageWorker_projectId_idx" ON "PrevailingWageWorker"("projectId");
CREATE INDEX "PrevailingWageWorker_associateId_idx" ON "PrevailingWageWorker"("associateId");
CREATE INDEX "PrevailingWageWorker_tenantId_idx" ON "PrevailingWageWorker"("tenantId");
ALTER TABLE "PrevailingWageWorker" ADD CONSTRAINT "PrevailingWageWorker_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PrevailingWageProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrevailingWageWorker" ADD CONSTRAINT "PrevailingWageWorker_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PrevailingWageTimeTag" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "timeEntryId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "classification" VARCHAR(120),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrevailingWageTimeTag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrevailingWageTimeTag_timeEntryId_key" ON "PrevailingWageTimeTag"("timeEntryId");
CREATE INDEX "PrevailingWageTimeTag_projectId_idx" ON "PrevailingWageTimeTag"("projectId");
CREATE INDEX "PrevailingWageTimeTag_tenantId_idx" ON "PrevailingWageTimeTag"("tenantId");
ALTER TABLE "PrevailingWageTimeTag" ADD CONSTRAINT "PrevailingWageTimeTag_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrevailingWageTimeTag" ADD CONSTRAINT "PrevailingWageTimeTag_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PrevailingWageProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CertifiedPayrollReport" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "projectId" UUID NOT NULL,
  "weekEnding" DATE NOT NULL,
  "payrollNumber" INTEGER NOT NULL,
  "isFinal" BOOLEAN NOT NULL DEFAULT false,
  "status" VARCHAR(10) NOT NULL DEFAULT 'DRAFT',
  "snapshot" JSONB,
  "fringeStatement" VARCHAR(10),
  "exceptionsText" VARCHAR(2000),
  "signatureName" VARCHAR(120),
  "signerTitle" VARCHAR(120),
  "signedById" UUID,
  "signedAt" TIMESTAMPTZ(6),
  "signedIp" VARCHAR(64),
  "pdfHash" VARCHAR(64),
  "submittedAt" TIMESTAMPTZ(6),
  "submittedTo" VARCHAR(200),
  "confirmation" VARCHAR(120),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CertifiedPayrollReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CertifiedPayrollReport_projectId_weekEnding_key" ON "CertifiedPayrollReport"("projectId", "weekEnding");
CREATE INDEX "CertifiedPayrollReport_tenantId_status_idx" ON "CertifiedPayrollReport"("tenantId", "status");
ALTER TABLE "CertifiedPayrollReport" ADD CONSTRAINT "CertifiedPayrollReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PrevailingWageProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContractorProfile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "legalName" VARCHAR(200),
  "businessName" VARCHAR(200),
  "taxClassification" VARCHAR(30),
  "llcTaxClass" VARCHAR(1),
  "exemptPayeeCode" VARCHAR(4),
  "fatcaCode" VARCHAR(4),
  "addressLine1" VARCHAR(200),
  "city" VARCHAR(80),
  "state" VARCHAR(2),
  "zip" VARCHAR(10),
  "tinType" VARCHAR(3),
  "tinLast4" VARCHAR(4),
  "w9Status" VARCHAR(10) NOT NULL DEFAULT 'NONE',
  "w9RequestedAt" TIMESTAMPTZ(6),
  "w9SignedAt" TIMESTAMPTZ(6),
  "w9SignatureName" VARCHAR(120),
  "w9SignedIp" VARCHAR(64),
  "w9Hash" VARCHAR(64),
  "subjectToBackupCertified" BOOLEAN NOT NULL DEFAULT false,
  "tinMatchStatus" VARCHAR(12) NOT NULL DEFAULT 'NOT_CHECKED',
  "tinMatchCode" INTEGER,
  "tinMatchCheckedAt" TIMESTAMPTZ(6),
  "backupWithholding" BOOLEAN NOT NULL DEFAULT false,
  "backupReason" VARCHAR(30),
  "backupStartedAt" TIMESTAMPTZ(6),
  "backupStoppedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractorProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContractorProfile_associateId_key" ON "ContractorProfile"("associateId");
CREATE INDEX "ContractorProfile_tenantId_idx" ON "ContractorProfile"("tenantId");
ALTER TABLE "ContractorProfile" ADD CONSTRAINT "ContractorProfile_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TinMatchBatch" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "kind" VARCHAR(12) NOT NULL DEFAULT 'BULK',
  "status" VARCHAR(16) NOT NULL DEFAULT 'GENERATED',
  "requestedCount" INTEGER NOT NULL DEFAULT 0,
  "summary" JSONB,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resultsLoadedAt" TIMESTAMPTZ(6),
  CONSTRAINT "TinMatchBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TinMatchBatch_tenantId_createdAt_idx" ON "TinMatchBatch"("tenantId", "createdAt");

CREATE TABLE "TinMatchResult" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "batchId" UUID NOT NULL,
  "profileId" UUID NOT NULL,
  "accountNumber" VARCHAR(20) NOT NULL,
  "tinType" INTEGER NOT NULL,
  "resultCode" INTEGER,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TinMatchResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TinMatchResult_batchId_accountNumber_key" ON "TinMatchResult"("batchId", "accountNumber");
CREATE INDEX "TinMatchResult_profileId_idx" ON "TinMatchResult"("profileId");
CREATE INDEX "TinMatchResult_tenantId_idx" ON "TinMatchResult"("tenantId");
ALTER TABLE "TinMatchResult" ADD CONSTRAINT "TinMatchResult_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "TinMatchBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TinMatchResult" ADD CONSTRAINT "TinMatchResult_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ContractorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BNotice" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "profileId" UUID NOT NULL,
  "kind" VARCHAR(6) NOT NULL,
  "irsNoticeKind" VARCHAR(10) NOT NULL DEFAULT 'CP2100',
  "irsNoticeReceivedOn" DATE NOT NULL,
  "nameOnNotice" VARCHAR(200),
  "tinLast4OnNotice" VARCHAR(4),
  "sendBy" DATE NOT NULL,
  "sentAt" TIMESTAMPTZ(6),
  "backupBy" DATE NOT NULL,
  "respondedAt" TIMESTAMPTZ(6),
  "resolution" VARCHAR(20),
  "letterHash" VARCHAR(64),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BNotice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BNotice_profileId_idx" ON "BNotice"("profileId");
CREATE INDEX "BNotice_tenantId_idx" ON "BNotice"("tenantId");
ALTER TABLE "BNotice" ADD CONSTRAINT "BNotice_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ContractorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContractorPaymentRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "name" VARCHAR(120) NOT NULL,
  "payDate" DATE NOT NULL,
  "status" VARCHAR(10) NOT NULL DEFAULT 'DRAFT',
  "createdById" UUID,
  "approvedById" UUID,
  "approvedAt" TIMESTAMPTZ(6),
  "paidAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractorPaymentRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContractorPaymentRun_tenantId_status_idx" ON "ContractorPaymentRun"("tenantId", "status");

CREATE TABLE "ContractorPayment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "runId" UUID NOT NULL,
  "associateId" UUID NOT NULL,
  "description" VARCHAR(300) NOT NULL,
  "invoiceNumber" VARCHAR(60),
  "form" VARCHAR(10) NOT NULL DEFAULT 'NEC',
  "miscBox" INTEGER,
  "amount" DECIMAL(12,2) NOT NULL,
  "backupWithheld" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "netAmount" DECIMAL(12,2) NOT NULL,
  "workState" VARCHAR(2),
  "stateWithheld" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "paymentMethod" VARCHAR(20),
  "reference" VARCHAR(120),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractorPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContractorPayment_runId_idx" ON "ContractorPayment"("runId");
CREATE INDEX "ContractorPayment_associateId_idx" ON "ContractorPayment"("associateId");
CREATE INDEX "ContractorPayment_tenantId_idx" ON "ContractorPayment"("tenantId");
ALTER TABLE "ContractorPayment" ADD CONSTRAINT "ContractorPayment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ContractorPaymentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContractorPayment" ADD CONSTRAINT "ContractorPayment_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "State1099Filing" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "state" VARCHAR(2) NOT NULL,
  "cfsf" BOOLEAN NOT NULL DEFAULT false,
  "directFiling" BOOLEAN NOT NULL DEFAULT false,
  "payerStateId" VARCHAR(40),
  "notes" VARCHAR(500),
  "updatedById" UUID,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "State1099Filing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "State1099Filing_tenantId_state_key" ON "State1099Filing"("tenantId", "state");
