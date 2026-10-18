-- Moving the money ourselves: ACH origination through a bank partner (or a
-- NACHA file for the tenant's own bank), the employer's funding debit that
-- gates every disbursement, prenotes and split deposits on employee
-- accounts, and the banking-day calendar pay dates respect.

ALTER TYPE "ProviderKind" ADD VALUE IF NOT EXISTS 'ORIGINATION';
ALTER TYPE "ApprovalRequestKind" ADD VALUE IF NOT EXISTS 'PAYROLL_FUNDING_LIMIT';

-- Per tenant (employerOrgId NULL) or per employer of record: how pay moves.
CREATE TABLE "PayrollBankingProfile" (
  "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"                 UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "employerOrgId"            UUID,
  "bankRail"                 VARCHAR(12) NOT NULL DEFAULT 'PLATFORM',
  "achSpeed"                 VARCHAR(12) NOT NULL DEFAULT 'NEXT_DAY',
  "submitCutoffEt"           VARCHAR(5)  NOT NULL DEFAULT '16:00',
  "companyName"              VARCHAR(16),
  "companyId"                VARCHAR(10),
  "companyEntryDescription"  VARCHAR(10) NOT NULL DEFAULT 'PAYROLL',
  "immediateDestination"     VARCHAR(10),
  "immediateDestinationName" VARCHAR(23),
  "immediateOrigin"          VARCHAR(10),
  "immediateOriginName"      VARCHAR(23),
  "originatingDfi"           VARCHAR(8),
  "kybStatus"                VARCHAR(12) NOT NULL DEFAULT 'NOT_STARTED',
  "kybCheckedAt"             TIMESTAMPTZ(6),
  "kybNote"                  VARCHAR(500),
  "perRunLimitCents"         BIGINT,
  "perDayLimitCents"         BIGINT,
  "requirePrenote"           BOOLEAN NOT NULL DEFAULT true,
  "fundingAccountId"         UUID,
  "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PayrollBankingProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollBankingProfile_tenantId_employerOrgId_key" ON "PayrollBankingProfile"("tenantId", "employerOrgId");
CREATE INDEX "PayrollBankingProfile_tenantId_idx" ON "PayrollBankingProfile"("tenantId");

-- The employer's operating account the funding debit pulls from.
CREATE TABLE "EmployerBankAccount" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"             UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "employerOrgId"        UUID,
  "label"                VARCHAR(80) NOT NULL,
  "bankName"             VARCHAR(120),
  "routingNumber"        VARCHAR(9) NOT NULL,
  "accountNumberEnc"     BYTEA NOT NULL,
  "accountLast4"         VARCHAR(4) NOT NULL,
  "accountType"          VARCHAR(10) NOT NULL DEFAULT 'CHECKING',
  "status"               VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIED',
  "microDepositHash"     VARCHAR(128),
  "microDepositSentAt"   TIMESTAMPTZ(6),
  "microDepositAttempts" INTEGER NOT NULL DEFAULT 0,
  "verifiedAt"           TIMESTAMPTZ(6),
  "verifiedById"         UUID,
  "createdById"          UUID,
  "createdAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "EmployerBankAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployerBankAccount_tenantId_idx" ON "EmployerBankAccount"("tenantId");

-- One NACHA file: what it carried, kept encrypted, and where it went.
CREATE TABLE "AchFile" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "purpose"          VARCHAR(16) NOT NULL,
  "provider"         VARCHAR(20) NOT NULL,
  "connectionId"     UUID,
  "payrollRunId"     UUID,
  "fileIdModifier"   VARCHAR(1) NOT NULL,
  "effectiveDate"    DATE NOT NULL,
  "sameDay"          BOOLEAN NOT NULL DEFAULT false,
  "entryCount"       INTEGER NOT NULL,
  "totalDebitCents"  BIGINT NOT NULL DEFAULT 0,
  "totalCreditCents" BIGINT NOT NULL DEFAULT 0,
  "contentEnc"       BYTEA NOT NULL,
  "sha256"           VARCHAR(64) NOT NULL,
  "status"           VARCHAR(12) NOT NULL DEFAULT 'CREATED',
  "externalRef"      VARCHAR(120),
  "error"            VARCHAR(500),
  "submittedAt"      TIMESTAMPTZ(6),
  "createdById"      UUID,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "AchFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AchFile_tenantId_createdAt_idx" ON "AchFile"("tenantId", "createdAt" DESC);
CREATE INDEX "AchFile_payrollRunId_idx" ON "AchFile"("payrollRunId");

-- One entry in a file: a credit to a person, the employer's debit, a prenote.
CREATE TABLE "AchEntry" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"        UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "achFileId"       UUID NOT NULL,
  "traceNumber"     VARCHAR(15) NOT NULL,
  "kind"            VARCHAR(16) NOT NULL,
  "transactionCode" VARCHAR(2) NOT NULL,
  "amountCents"     BIGINT NOT NULL,
  "payrollItemId"   UUID,
  "payoutMethodId"  UUID,
  "bankAccountId"   UUID,
  "associateId"     UUID,
  "individualName"  VARCHAR(22) NOT NULL,
  "accountLast4"    VARCHAR(4) NOT NULL,
  "status"          VARCHAR(12) NOT NULL DEFAULT 'SENT',
  "returnCode"      VARCHAR(3),
  "returnedAt"      TIMESTAMPTZ(6),
  "nocCode"         VARCHAR(3),
  "nocData"         VARCHAR(29),
  "nocAppliedAt"    TIMESTAMPTZ(6),
  "externalRef"     VARCHAR(120),
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "AchEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AchEntry_achFileId_fkey" FOREIGN KEY ("achFileId") REFERENCES "AchFile"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AchEntry_tenantId_traceNumber_key" ON "AchEntry"("tenantId", "traceNumber");
CREATE INDEX "AchEntry_payrollItemId_idx" ON "AchEntry"("payrollItemId");
CREATE INDEX "AchEntry_payoutMethodId_idx" ON "AchEntry"("payoutMethodId");
CREATE INDEX "AchEntry_externalRef_idx" ON "AchEntry"("externalRef");

-- The money behind one run: pulled from the employer before anyone is paid.
CREATE TABLE "PayrollFunding" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"           UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "payrollRunId"       UUID NOT NULL,
  "employerOrgId"      UUID,
  "bankAccountId"      UUID,
  "amountCents"        BIGINT NOT NULL,
  "breakdown"          JSONB NOT NULL DEFAULT '{}',
  "payDate"            DATE NOT NULL,
  "debitEffectiveDate" DATE NOT NULL,
  "fundingDeadline"    TIMESTAMPTZ(6) NOT NULL,
  "achSpeed"           VARCHAR(12) NOT NULL,
  "status"             VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  "achEntryId"         UUID,
  "approvalRequestId"  UUID,
  "returnCode"         VARCHAR(3),
  "returnReason"       VARCHAR(300),
  "submittedAt"        TIMESTAMPTZ(6),
  "settledAt"          TIMESTAMPTZ(6),
  "returnedAt"         TIMESTAMPTZ(6),
  "note"               VARCHAR(500),
  "createdById"        UUID,
  "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PayrollFunding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollFunding_payrollRunId_key" ON "PayrollFunding"("payrollRunId");
CREATE INDEX "PayrollFunding_tenantId_status_idx" ON "PayrollFunding"("tenantId", "status");

-- A day the tenant's bank is closed beyond the Federal Reserve's own holidays (or open on one).
CREATE TABLE "BankHolidayOverride" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "date"        DATE NOT NULL,
  "name"        VARCHAR(120) NOT NULL,
  "closed"      BOOLEAN NOT NULL DEFAULT true,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "BankHolidayOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BankHolidayOverride_tenantId_date_key" ON "BankHolidayOverride"("tenantId", "date");

-- Employee accounts: split deposits and the prenote that tests a new account.
ALTER TABLE "PayoutMethod"
  ADD COLUMN "splitKind"            VARCHAR(10),
  ADD COLUMN "splitAmountCents"     INTEGER,
  ADD COLUMN "splitPercent"         DECIMAL(5,2),
  ADD COLUMN "splitOrder"           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "prenoteStatus"        VARCHAR(10),
  ADD COLUMN "prenoteSentAt"        TIMESTAMPTZ(6),
  ADD COLUMN "prenoteEffectiveDate" DATE;
