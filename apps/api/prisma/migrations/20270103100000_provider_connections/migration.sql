-- Service providers: E-Verify, background checks, drug tests, tax filing and
-- payouts, each a per-tenant connection with encrypted credentials, a
-- sandbox/production switch, health, and an idempotent event log for the
-- provider's webhooks. The domain rows gain the provider's ids and states.

CREATE TYPE "ProviderKind" AS ENUM ('EVERIFY', 'BACKGROUND_CHECK', 'DRUG_TEST', 'TAX_FILING', 'PAYOUT');

CREATE TABLE "ProviderConnection" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"        UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "kind"            "ProviderKind" NOT NULL,
  "provider"        VARCHAR(30) NOT NULL,
  "name"            VARCHAR(120) NOT NULL,
  "environment"     VARCHAR(12) NOT NULL DEFAULT 'SANDBOX',
  "active"          BOOLEAN NOT NULL DEFAULT TRUE,
  "credentialsEnc"  BYTEA,
  "webhookSecretEnc" BYTEA,
  "settings"        JSONB NOT NULL DEFAULT '{}',
  "lastSuccessAt"   TIMESTAMPTZ(6),
  "lastErrorAt"     TIMESTAMPTZ(6),
  "lastError"       VARCHAR(500),
  "lastTestAt"      TIMESTAMPTZ(6),
  "lastTestOk"      BOOLEAN,
  "createdByUserId" UUID,
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProviderConnection_tenantId_kind_idx" ON "ProviderConnection"("tenantId", "kind");

CREATE TABLE "ProviderEvent" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "connectionId" UUID NOT NULL,
  "kind"         "ProviderKind" NOT NULL,
  "direction"    VARCHAR(4) NOT NULL,
  "eventType"    VARCHAR(80) NOT NULL,
  "externalId"   VARCHAR(160) NOT NULL,
  "subjectType"  VARCHAR(40),
  "subjectId"    UUID,
  "status"       VARCHAR(12) NOT NULL DEFAULT 'RECEIVED',
  "error"        VARCHAR(500),
  "payload"      JSONB,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "processedAt"  TIMESTAMPTZ(6),
  CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProviderEvent_connectionId_externalId_key" ON "ProviderEvent"("connectionId", "externalId");
CREATE INDEX "ProviderEvent_tenantId_status_createdAt_idx" ON "ProviderEvent"("tenantId", "status", "createdAt");
CREATE INDEX "ProviderEvent_subjectType_subjectId_idx" ON "ProviderEvent"("subjectType", "subjectId");

-- E-Verify: the provider that holds the case, the deadline, and the
-- Tentative Nonconfirmation (mismatch) steps the law requires.
ALTER TABLE "I9Verification"
  ADD COLUMN "eVerifyConnectionId"     UUID,
  ADD COLUMN "eVerifyDueBy"            DATE,
  ADD COLUMN "eVerifyRawStatus"        VARCHAR(80),
  ADD COLUMN "eVerifyTncNotifiedAt"    TIMESTAMPTZ(6),
  ADD COLUMN "eVerifyTncDecision"      VARCHAR(12),
  ADD COLUMN "eVerifyReferredAt"       TIMESTAMPTZ(6),
  ADD COLUMN "eVerifyReferralDeadline" DATE,
  ADD COLUMN "eVerifyClosureReason"    VARCHAR(60),
  ADD COLUMN "eVerifyLastSyncAt"       TIMESTAMPTZ(6),
  ADD COLUMN "eVerifyLastError"        VARCHAR(500);

-- Background checks: the package ordered, the candidate's invitation, the
-- report, and the FCRA adverse-action steps.
ALTER TABLE "BackgroundCheck"
  ADD COLUMN "connectionId"        UUID,
  ADD COLUMN "packageCode"         VARCHAR(80),
  ADD COLUMN "externalCandidateId" VARCHAR(80),
  ADD COLUMN "invitationUrl"       VARCHAR(500),
  ADD COLUMN "rawStatus"           VARCHAR(40),
  ADD COLUMN "result"              VARCHAR(20),
  ADD COLUMN "adjudication"        VARCHAR(20),
  ADD COLUMN "preAdverseSentAt"    TIMESTAMPTZ(6),
  ADD COLUMN "adverseWaitUntil"    TIMESTAMPTZ(6),
  ADD COLUMN "adverseSentAt"       TIMESTAMPTZ(6),
  ADD COLUMN "adverseActionId"     VARCHAR(80),
  ADD COLUMN "lastSyncAt"          TIMESTAMPTZ(6),
  ADD COLUMN "lastError"           VARCHAR(500);

-- Drug tests: the order, where and until when to collect, and the MRO result.
ALTER TABLE "DrugTest"
  ADD COLUMN "connectionId"       UUID,
  ADD COLUMN "panelCode"          VARCHAR(40),
  ADD COLUMN "reason"             VARCHAR(30),
  ADD COLUMN "donorPassUrl"       VARCHAR(500),
  ADD COLUMN "donorPassExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "collectionSite"     VARCHAR(300),
  ADD COLUMN "rawStatus"          VARCHAR(40),
  ADD COLUMN "resultCode"         VARCHAR(20),
  ADD COLUMN "mroVerifiedAt"      TIMESTAMPTZ(6),
  ADD COLUMN "lastSyncAt"         TIMESTAMPTZ(6),
  ADD COLUMN "lastError"          VARCHAR(500);

-- Tax filing: the e-file submission and the agency's answer.
ALTER TABLE "TaxForm"
  ADD COLUMN "efileConnectionId"   UUID,
  ADD COLUMN "efileSubmissionId"   VARCHAR(80),
  ADD COLUMN "efileRecordId"       VARCHAR(80),
  ADD COLUMN "efileStatus"         VARCHAR(20),
  ADD COLUMN "efileSubmittedAt"    TIMESTAMPTZ(6),
  ADD COLUMN "efileStatusAt"       TIMESTAMPTZ(6),
  ADD COLUMN "efileRejectionReason" VARCHAR(500);

CREATE INDEX "TaxForm_efileSubmissionId_idx" ON "TaxForm"("efileSubmissionId");
CREATE INDEX "BackgroundCheck_externalId_idx" ON "BackgroundCheck"("externalId");
CREATE INDEX "DrugTest_externalId_idx" ON "DrugTest"("externalId");
CREATE INDEX "PayrollDisbursementAttempt_externalRef_idx" ON "PayrollDisbursementAttempt"("externalRef");
