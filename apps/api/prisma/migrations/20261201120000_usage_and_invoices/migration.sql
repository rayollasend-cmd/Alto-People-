-- Brief 2-6 step 4 — usage by worker type, monthly billable counts, prices and invoices.
-- Additive. No price ships: the owner gives them (decision 3), and an invoice waits as a
-- draft until its prices exist. Stripe stays in test mode until the owner approves live.

-- CreateTable
CREATE TABLE "UsageSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "day" DATE NOT NULL,
    "type" VARCHAR(8) NOT NULL,
    "count" INTEGER NOT NULL,
    "ids" TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "month" VARCHAR(7) NOT NULL,
    "type" VARCHAR(8) NOT NULL,
    "billableCount" INTEGER NOT NULL,
    "evidenceHash" VARCHAR(64) NOT NULL,
    "computedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPrice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan" VARCHAR(40) NOT NULL,
    "type" VARCHAR(8) NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingInvoice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "month" VARCHAR(7) NOT NULL,
    "plan" VARCHAR(40) NOT NULL,
    "lines" JSONB NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'DRAFT',
    "holdReason" VARCHAR(120),
    "stripeInvoiceId" VARCHAR(120),
    "hostedUrl" VARCHAR(1000),
    "lastPaymentError" VARCHAR(500),
    "paidAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageSnapshot_tenantId_day_type_key" ON "UsageSnapshot"("tenantId", "day", "type");

-- CreateIndex
CREATE UNIQUE INDEX "UsageRecord_tenantId_month_type_key" ON "UsageRecord"("tenantId", "month", "type");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPrice_plan_type_effectiveFrom_key" ON "BillingPrice"("plan", "type", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_tenantId_month_key" ON "BillingInvoice"("tenantId", "month");

-- CreateIndex
CREATE INDEX "BillingInvoice_stripeInvoiceId_idx" ON "BillingInvoice"("stripeInvoiceId");

ALTER TABLE "UsageSnapshot" ADD CONSTRAINT "UsageSnapshot_type_check" CHECK ("type" IN ('PERSON', 'AGENT', 'ROBOT') AND "count" = cardinality("ids"));
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_type_check" CHECK ("type" IN ('PERSON', 'AGENT', 'ROBOT') AND "month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "BillingPrice" ADD CONSTRAINT "BillingPrice_type_check" CHECK ("type" IN ('PERSON', 'AGENT', 'ROBOT') AND "unitPriceCents" >= 0);
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_status_check" CHECK ("status" IN ('DRAFT', 'OPEN', 'PAID', 'VOID'));
