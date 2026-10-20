-- The books: the company's own finance engine.
--
--   LedgerAccount / JournalEntry / JournalLine   a double-entry general
--       ledger. The platform posts to it on its own (payroll, statements,
--       client payments, tax deposits, reimbursements, garnishments, bills,
--       bank activity, depreciation); sourceKey keeps that idempotent.
--   FiscalPeriod / CloseTask   the month-end close: a checklist, a lock,
--       and a second person's sign-off. A CLOSED month takes no posting.
--   Vendor / Bill / BillLine / RecurringBill / BillPayment(+Application)
--       payables, approved by a second person before they're paid.
--   ClientPayment(+Application)   money received against statements.
--   BankFeedAccount / BankTransaction / BankRule / BankReconciliation
--       bank and card activity, matched or categorized, and reconciled.
--   Budget / BudgetLine   budget vs actual by account, month, client, department.
--   FixedAsset / DepreciationEntry   the register and its monthly depreciation.
--   QboCompanyConnection / QboSyncLink / QboOutbox / QboSyncConflict / QboSyncEvent
--       the two-way sync with the company's own QuickBooks Online.
--
-- Hand-assembled from `prisma migrate diff` between the two schema files
-- (no database involved) plus the CHECK constraints below.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalRequestKind" ADD VALUE 'BILL_APPROVAL';
ALTER TYPE "ApprovalRequestKind" ADD VALUE 'VENDOR_BANK';
ALTER TYPE "ApprovalRequestKind" ADD VALUE 'PERIOD_REOPEN';

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" VARCHAR(12) NOT NULL,
    "subtype" VARCHAR(32) NOT NULL,
    "systemKey" VARCHAR(48),
    "parentId" UUID,
    "description" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "number" INTEGER NOT NULL,
    "entryDate" DATE NOT NULL,
    "periodKey" VARCHAR(7) NOT NULL,
    "memo" VARCHAR(500),
    "source" VARCHAR(24) NOT NULL,
    "sourceType" VARCHAR(40),
    "sourceId" VARCHAR(64),
    "sourceKey" VARCHAR(160),
    "status" VARCHAR(8) NOT NULL DEFAULT 'POSTED',
    "origin" VARCHAR(12) NOT NULL DEFAULT 'SITE',
    "reverseOn" DATE,
    "reversesId" UUID,
    "totalDebit" DECIMAL(14,2) NOT NULL,
    "createdById" UUID,
    "postedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMPTZ(6),
    "voidedById" UUID,
    "voidReason" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "entryId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" UUID NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "memo" VARCHAR(300),
    "clientId" UUID,
    "siteId" UUID,
    "departmentId" UUID,
    "costCenterId" UUID,
    "vendorId" UUID,
    "clearedAt" TIMESTAMPTZ(6),
    "reconciliationId" UUID,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalPeriod" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "periodKey" VARCHAR(7) NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMPTZ(6),
    "closedById" UUID,
    "signedOffById" UUID,
    "signedOffAt" TIMESTAMPTZ(6),
    "reopenedAt" TIMESTAMPTZ(6),
    "reopenedById" UUID,
    "reopenReason" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloseTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "periodId" UUID NOT NULL,
    "key" VARCHAR(48) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "detail" VARCHAR(1000),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "ownerUserId" UUID,
    "status" VARCHAR(8) NOT NULL DEFAULT 'OPEN',
    "doneAt" TIMESTAMPTZ(6),
    "doneById" UUID,
    "note" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CloseTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "name" VARCHAR(160) NOT NULL,
    "email" VARCHAR(200),
    "phone" VARCHAR(40),
    "addressLine1" VARCHAR(200),
    "addressLine2" VARCHAR(200),
    "city" VARCHAR(100),
    "state" VARCHAR(2),
    "zip" VARCHAR(10),
    "is1099" BOOLEAN NOT NULL DEFAULT false,
    "taxIdEnc" BYTEA,
    "taxIdLast4" VARCHAR(4),
    "defaultExpenseAccountId" UUID,
    "paymentMethod" VARCHAR(8) NOT NULL DEFAULT 'ACH',
    "routingNumberEnc" BYTEA,
    "accountNumberEnc" BYTEA,
    "accountLast4" VARCHAR(4),
    "termsDays" INTEGER NOT NULL DEFAULT 30,
    "notes" VARCHAR(1000),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "vendorId" UUID NOT NULL,
    "billNumber" VARCHAR(60),
    "billDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "total" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,
    "memo" VARCHAR(500),
    "attachmentKey" VARCHAR(300),
    "attachmentName" VARCHAR(200),
    "approvalRequestId" UUID,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "journalEntryId" UUID,
    "recurringId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "voidedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "billId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" UUID NOT NULL,
    "description" VARCHAR(300),
    "amount" DECIMAL(14,2) NOT NULL,
    "clientId" UUID,
    "siteId" UUID,
    "departmentId" UUID,
    "costCenterId" UUID,

    CONSTRAINT "BillLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringBill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "vendorId" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "frequency" VARCHAR(10) NOT NULL,
    "nextDate" DATE NOT NULL,
    "endDate" DATE,
    "template" JSONB NOT NULL,
    "memo" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RecurringBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillPayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "vendorId" UUID NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" VARCHAR(8) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "reference" VARCHAR(80),
    "checkNumber" INTEGER,
    "achFileId" UUID,
    "status" VARCHAR(10) NOT NULL DEFAULT 'SCHEDULED',
    "journalEntryId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "voidedAt" TIMESTAMPTZ(6),

    CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillPaymentApplication" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "paymentId" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "BillPaymentApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "clientId" UUID NOT NULL,
    "receivedOn" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" VARCHAR(8) NOT NULL,
    "reference" VARCHAR(80),
    "depositAccountId" UUID NOT NULL,
    "journalEntryId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ClientPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPaymentApplication" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "paymentId" UUID NOT NULL,
    "statementId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "ClientPaymentApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankFeedAccount" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "ledgerAccountId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "institution" VARCHAR(120),
    "mask" VARCHAR(8),
    "feed" VARCHAR(8) NOT NULL DEFAULT 'MANUAL',
    "providerConnectionId" UUID,
    "providerAccountId" VARCHAR(120),
    "cursor" VARCHAR(500),
    "currentBalance" DECIMAL(14,2),
    "lastSyncedAt" TIMESTAMPTZ(6),
    "lastError" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankFeedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "feedAccountId" UUID NOT NULL,
    "postedOn" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "payee" VARCHAR(160),
    "reference" VARCHAR(80),
    "externalId" VARCHAR(160) NOT NULL,
    "importedFrom" VARCHAR(4) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'UNMATCHED',
    "matchedLineId" UUID,
    "journalEntryId" UUID,
    "ruleId" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankRule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "name" VARCHAR(120) NOT NULL,
    "contains" VARCHAR(120) NOT NULL,
    "direction" VARCHAR(4) NOT NULL DEFAULT 'ANY',
    "minAmount" DECIMAL(14,2),
    "maxAmount" DECIMAL(14,2),
    "accountId" UUID NOT NULL,
    "vendorId" UUID,
    "clientId" UUID,
    "departmentId" UUID,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankReconciliation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "feedAccountId" UUID NOT NULL,
    "statementEndDate" DATE NOT NULL,
    "statementBalance" DECIMAL(14,2) NOT NULL,
    "beginningBalance" DECIMAL(14,2) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'IN_PROGRESS',
    "completedAt" TIMESTAMPTZ(6),
    "completedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "name" VARCHAR(120) NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'DRAFT',
    "notes" VARCHAR(1000),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "budgetId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "periodKey" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "clientId" UUID,
    "departmentId" UUID,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedAsset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "name" VARCHAR(160) NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "assetId" UUID,
    "vanId" UUID,
    "acquiredOn" DATE NOT NULL,
    "inServiceOn" DATE NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "salvageValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "method" VARCHAR(20) NOT NULL DEFAULT 'STRAIGHT_LINE',
    "assetAccountId" UUID NOT NULL,
    "accumulatedAccountId" UUID NOT NULL,
    "expenseAccountId" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "disposedOn" DATE,
    "disposalProceeds" DECIMAL(14,2),
    "acquisitionEntryId" UUID,
    "disposalEntryId" UUID,
    "clientId" UUID,
    "siteId" UUID,
    "departmentId" UUID,
    "notes" VARCHAR(1000),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepreciationEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "fixedAssetId" UUID NOT NULL,
    "periodKey" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "journalEntryId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepreciationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QboCompanyConnection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "realmId" VARCHAR(40) NOT NULL,
    "companyName" VARCHAR(160),
    "accessTokenEnc" BYTEA NOT NULL,
    "refreshTokenEnc" BYTEA NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "lastRefreshedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(16) NOT NULL DEFAULT 'CONNECTED',
    "pulledThrough" TIMESTAMPTZ(6),
    "lastPushAt" TIMESTAMPTZ(6),
    "lastPullAt" TIMESTAMPTZ(6),
    "lastError" VARCHAR(1000),
    "qboClosingDate" DATE,
    "connectedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "QboCompanyConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QboSyncLink" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "localType" VARCHAR(24) NOT NULL,
    "localId" UUID NOT NULL,
    "qboType" VARCHAR(24) NOT NULL,
    "qboId" VARCHAR(40) NOT NULL,
    "syncToken" VARCHAR(20),
    "owner" VARCHAR(12) NOT NULL,
    "localHash" VARCHAR(64),
    "remoteHash" VARCHAR(64),
    "lastSyncedAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "QboSyncLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QboOutbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "localType" VARCHAR(24) NOT NULL,
    "localId" UUID NOT NULL,
    "op" VARCHAR(8) NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "QboOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QboSyncConflict" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "linkId" UUID NOT NULL,
    "localType" VARCHAR(24) NOT NULL,
    "localId" UUID NOT NULL,
    "summary" VARCHAR(300) NOT NULL,
    "siteVersion" JSONB NOT NULL,
    "qboVersion" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QboSyncConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QboSyncEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "direction" VARCHAR(4) NOT NULL,
    "localType" VARCHAR(24),
    "localId" UUID,
    "qboType" VARCHAR(24),
    "qboId" VARCHAR(40),
    "result" VARCHAR(8) NOT NULL,
    "message" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QboSyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerAccount_tenantId_type_idx" ON "LedgerAccount"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_tenantId_code_key" ON "LedgerAccount"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_tenantId_systemKey_key" ON "LedgerAccount"("tenantId", "systemKey");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_periodKey_idx" ON "JournalEntry"("tenantId", "periodKey");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_entryDate_idx" ON "JournalEntry"("tenantId", "entryDate");

-- CreateIndex
CREATE INDEX "JournalEntry_tenantId_source_idx" ON "JournalEntry"("tenantId", "source");

-- CreateIndex
CREATE INDEX "JournalEntry_sourceType_sourceId_idx" ON "JournalEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_tenantId_number_key" ON "JournalEntry"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_tenantId_sourceKey_key" ON "JournalEntry"("tenantId", "sourceKey");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE INDEX "JournalLine_tenantId_accountId_idx" ON "JournalLine"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "JournalLine_tenantId_clientId_idx" ON "JournalLine"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "JournalLine_reconciliationId_idx" ON "JournalLine"("reconciliationId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriod_tenantId_periodKey_key" ON "FiscalPeriod"("tenantId", "periodKey");

-- CreateIndex
CREATE INDEX "CloseTask_tenantId_idx" ON "CloseTask"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CloseTask_periodId_key_key" ON "CloseTask"("periodId", "key");

-- CreateIndex
CREATE INDEX "Vendor_tenantId_isActive_idx" ON "Vendor"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "Bill_tenantId_status_idx" ON "Bill"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Bill_vendorId_idx" ON "Bill"("vendorId");

-- CreateIndex
CREATE INDEX "Bill_tenantId_dueDate_idx" ON "Bill"("tenantId", "dueDate");

-- CreateIndex
CREATE INDEX "BillLine_billId_idx" ON "BillLine"("billId");

-- CreateIndex
CREATE INDEX "BillLine_tenantId_idx" ON "BillLine"("tenantId");

-- CreateIndex
CREATE INDEX "RecurringBill_tenantId_isActive_nextDate_idx" ON "RecurringBill"("tenantId", "isActive", "nextDate");

-- CreateIndex
CREATE INDEX "BillPayment_tenantId_paidOn_idx" ON "BillPayment"("tenantId", "paidOn");

-- CreateIndex
CREATE INDEX "BillPayment_vendorId_idx" ON "BillPayment"("vendorId");

-- CreateIndex
CREATE INDEX "BillPaymentApplication_billId_idx" ON "BillPaymentApplication"("billId");

-- CreateIndex
CREATE INDEX "BillPaymentApplication_tenantId_idx" ON "BillPaymentApplication"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BillPaymentApplication_paymentId_billId_key" ON "BillPaymentApplication"("paymentId", "billId");

-- CreateIndex
CREATE INDEX "ClientPayment_tenantId_receivedOn_idx" ON "ClientPayment"("tenantId", "receivedOn");

-- CreateIndex
CREATE INDEX "ClientPayment_clientId_idx" ON "ClientPayment"("clientId");

-- CreateIndex
CREATE INDEX "ClientPaymentApplication_statementId_idx" ON "ClientPaymentApplication"("statementId");

-- CreateIndex
CREATE INDEX "ClientPaymentApplication_tenantId_idx" ON "ClientPaymentApplication"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPaymentApplication_paymentId_statementId_key" ON "ClientPaymentApplication"("paymentId", "statementId");

-- CreateIndex
CREATE UNIQUE INDEX "BankFeedAccount_tenantId_ledgerAccountId_key" ON "BankFeedAccount"("tenantId", "ledgerAccountId");

-- CreateIndex
CREATE INDEX "BankTransaction_tenantId_status_idx" ON "BankTransaction"("tenantId", "status");

-- CreateIndex
CREATE INDEX "BankTransaction_feedAccountId_postedOn_idx" ON "BankTransaction"("feedAccountId", "postedOn");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_feedAccountId_externalId_key" ON "BankTransaction"("feedAccountId", "externalId");

-- CreateIndex
CREATE INDEX "BankRule_tenantId_isActive_idx" ON "BankRule"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "BankReconciliation_tenantId_idx" ON "BankReconciliation"("tenantId");

-- CreateIndex
CREATE INDEX "BankReconciliation_feedAccountId_statementEndDate_idx" ON "BankReconciliation"("feedAccountId", "statementEndDate");

-- CreateIndex
CREATE INDEX "Budget_tenantId_fiscalYear_idx" ON "Budget"("tenantId", "fiscalYear");

-- CreateIndex
CREATE INDEX "BudgetLine_budgetId_periodKey_idx" ON "BudgetLine"("budgetId", "periodKey");

-- CreateIndex
CREATE INDEX "BudgetLine_tenantId_idx" ON "BudgetLine"("tenantId");

-- CreateIndex
CREATE INDEX "FixedAsset_tenantId_status_idx" ON "FixedAsset"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DepreciationEntry_tenantId_idx" ON "DepreciationEntry"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DepreciationEntry_fixedAssetId_periodKey_key" ON "DepreciationEntry"("fixedAssetId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "QboCompanyConnection_tenantId_key" ON "QboCompanyConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "QboSyncLink_tenantId_localType_localId_key" ON "QboSyncLink"("tenantId", "localType", "localId");

-- CreateIndex
CREATE UNIQUE INDEX "QboSyncLink_tenantId_qboType_qboId_key" ON "QboSyncLink"("tenantId", "qboType", "qboId");

-- CreateIndex
CREATE INDEX "QboOutbox_tenantId_status_nextAttemptAt_idx" ON "QboOutbox"("tenantId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "QboOutbox_localType_localId_idx" ON "QboOutbox"("localType", "localId");

-- CreateIndex
CREATE INDEX "QboSyncConflict_tenantId_status_idx" ON "QboSyncConflict"("tenantId", "status");

-- CreateIndex
CREATE INDEX "QboSyncEvent_tenantId_createdAt_idx" ON "QboSyncEvent"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloseTask" ADD CONSTRAINT "CloseTask_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "FiscalPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_recurringId_fkey" FOREIGN KEY ("recurringId") REFERENCES "RecurringBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillLine" ADD CONSTRAINT "BillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPaymentApplication" ADD CONSTRAINT "BillPaymentApplication_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "BillPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPaymentApplication" ADD CONSTRAINT "BillPaymentApplication_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPaymentApplication" ADD CONSTRAINT "ClientPaymentApplication_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ClientPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_feedAccountId_fkey" FOREIGN KEY ("feedAccountId") REFERENCES "BankFeedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReconciliation" ADD CONSTRAINT "BankReconciliation_feedAccountId_fkey" FOREIGN KEY ("feedAccountId") REFERENCES "BankFeedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationEntry" ADD CONSTRAINT "DepreciationEntry_fixedAssetId_fkey" FOREIGN KEY ("fixedAssetId") REFERENCES "FixedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---- Integrity the database holds, whatever the code does ---------------
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_type_check" CHECK ("type" IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'));
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_status_check" CHECK ("status" IN ('POSTED', 'VOID'));
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_origin_check" CHECK ("origin" IN ('SITE', 'QUICKBOOKS'));
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_period_check" CHECK ("periodKey" = to_char("entryDate", 'YYYY-MM'));
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_one_side_check" CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0)));
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_status_check" CHECK ("status" IN ('OPEN', 'CLOSED'));
ALTER TABLE "CloseTask" ADD CONSTRAINT "CloseTask_status_check" CHECK ("status" IN ('OPEN', 'DONE', 'SKIPPED'));
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_paymentMethod_check" CHECK ("paymentMethod" IN ('ACH', 'CHECK', 'CARD', 'OTHER'));
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_status_check" CHECK ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOID'));
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_amounts_check" CHECK ("total" >= 0 AND "balance" >= 0 AND "balance" <= "total");
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_frequency_check" CHECK ("frequency" IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'));
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_method_check" CHECK ("method" IN ('ACH', 'CHECK', 'CARD', 'OTHER'));
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_status_check" CHECK ("status" IN ('SCHEDULED', 'SENT', 'CLEARED', 'VOID'));
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_amount_check" CHECK ("amount" > 0);
ALTER TABLE "BillPaymentApplication" ADD CONSTRAINT "BillPaymentApplication_amount_check" CHECK ("amount" > 0);
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_method_check" CHECK ("method" IN ('ACH', 'CHECK', 'WIRE', 'CARD', 'OTHER'));
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_amount_check" CHECK ("amount" > 0);
ALTER TABLE "ClientPaymentApplication" ADD CONSTRAINT "ClientPaymentApplication_amount_check" CHECK ("amount" > 0);
ALTER TABLE "BankFeedAccount" ADD CONSTRAINT "BankFeedAccount_feed_check" CHECK ("feed" IN ('MANUAL', 'PLAID'));
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_status_check" CHECK ("status" IN ('UNMATCHED', 'MATCHED', 'CATEGORIZED', 'EXCLUDED'));
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_importedFrom_check" CHECK ("importedFrom" IN ('FEED', 'CSV', 'OFX'));
ALTER TABLE "BankRule" ADD CONSTRAINT "BankRule_direction_check" CHECK ("direction" IN ('IN', 'OUT', 'ANY'));
ALTER TABLE "BankReconciliation" ADD CONSTRAINT "BankReconciliation_status_check" CHECK ("status" IN ('IN_PROGRESS', 'COMPLETED'));
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'ARCHIVED'));
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_method_check" CHECK ("method" IN ('STRAIGHT_LINE', 'DECLINING_BALANCE'));
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_status_check" CHECK ("status" IN ('ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED'));
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_values_check" CHECK ("cost" >= 0 AND "salvageValue" >= 0 AND "salvageValue" <= "cost" AND "usefulLifeMonths" > 0);
ALTER TABLE "QboCompanyConnection" ADD CONSTRAINT "QboCompanyConnection_status_check" CHECK ("status" IN ('CONNECTED', 'NEEDS_RECONNECT', 'PAUSED', 'DISCONNECTED'));
ALTER TABLE "QboSyncLink" ADD CONSTRAINT "QboSyncLink_owner_check" CHECK ("owner" IN ('SITE', 'QUICKBOOKS'));
ALTER TABLE "QboOutbox" ADD CONSTRAINT "QboOutbox_op_check" CHECK ("op" IN ('UPSERT', 'DELETE'));
ALTER TABLE "QboOutbox" ADD CONSTRAINT "QboOutbox_status_check" CHECK ("status" IN ('PENDING', 'DONE', 'FAILED', 'SKIPPED'));
ALTER TABLE "QboSyncConflict" ADD CONSTRAINT "QboSyncConflict_status_check" CHECK ("status" IN ('OPEN', 'KEPT_SITE', 'KEPT_QUICKBOOKS', 'DISMISSED'));
ALTER TABLE "QboSyncEvent" ADD CONSTRAINT "QboSyncEvent_direction_check" CHECK ("direction" IN ('PUSH', 'PULL'));
ALTER TABLE "QboSyncEvent" ADD CONSTRAINT "QboSyncEvent_result_check" CHECK ("result" IN ('OK', 'ERROR', 'CONFLICT', 'SKIPPED'));
