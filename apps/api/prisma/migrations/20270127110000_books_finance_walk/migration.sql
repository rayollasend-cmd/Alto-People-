-- Books and finance, the role walk's fixes and audit Tier 1 #17/#18 (2026-10-21):
--   Client.salesTaxable / salesTaxRatePct   sales tax on a client's statements (was always $0.00)
--   OrgSetting.remitTo*                      the remit-to printed on invoices and statements
--   OrgSetting.cashMinimum                   the cash floor the forecast draws as a band
--   Tenant.billingName / billingEmail / stripeCustomerId   the billing contact and the Stripe customer
--   ClientCollectionNote                      the collections worklist's promises, calls and notes

ALTER TABLE "Client"
  ADD COLUMN "salesTaxable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "salesTaxRatePct" DECIMAL(6, 3);

ALTER TABLE "OrgSetting"
  ADD COLUMN "remitToName" VARCHAR(255),
  ADD COLUMN "remitToAddress" VARCHAR(500),
  ADD COLUMN "remitToInstructions" VARCHAR(500),
  ADD COLUMN "cashMinimum" DECIMAL(14, 2);

ALTER TABLE "Tenant"
  ADD COLUMN "billingName" VARCHAR(160),
  ADD COLUMN "billingEmail" VARCHAR(254),
  ADD COLUMN "stripeCustomerId" VARCHAR(120);

CREATE TABLE "ClientCollectionNote" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "clientId" UUID NOT NULL,
  "statementId" UUID,
  "kind" VARCHAR(10) NOT NULL DEFAULT 'NOTE',
  "note" VARCHAR(1000) NOT NULL,
  "promisedOn" DATE,
  "promisedAmount" DECIMAL(14, 2),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientCollectionNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientCollectionNote_tenantId_clientId_createdAt_idx" ON "ClientCollectionNote"("tenantId", "clientId", "createdAt" DESC);
CREATE INDEX "ClientCollectionNote_statementId_idx" ON "ClientCollectionNote"("statementId");
