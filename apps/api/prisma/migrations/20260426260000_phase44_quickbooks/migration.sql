-- Phase 44 — QuickBooks Online integration. Per-client OAuth connection;
-- payroll runs gain pointers back to the QBO JournalEntry on first sync.

CREATE TABLE "QuickbooksConnection" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"                 UUID NOT NULL UNIQUE,
  "realmId"                  TEXT NOT NULL,
  "accessTokenEnc"           BYTEA NOT NULL,
  "refreshTokenEnc"          BYTEA NOT NULL,
  "expiresAt"                TIMESTAMPTZ(6) NOT NULL,
  "lastRefreshedAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "accountSalariesExpense"   TEXT,
  "accountFederalTaxPayable" TEXT,
  "accountStateTaxPayable"   TEXT,
  "accountFicaPayable"       TEXT,
  "accountMedicarePayable"   TEXT,
  "accountBenefitsPayable"   TEXT,
  "accountNetPayPayable"     TEXT,
  "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"                TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "QuickbooksConnection_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE
);

ALTER TABLE "PayrollRun"
  ADD COLUMN "qboJournalEntryId" VARCHAR(64),
  ADD COLUMN "qboSyncedAt"       TIMESTAMPTZ(6),
  ADD COLUMN "qboSyncError"      TEXT;
