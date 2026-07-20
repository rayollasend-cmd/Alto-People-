-- Tier-2 — state/local tax depth: config-driven fallback rates, SUTA
-- experience-rate overrides, and city/county withholding.
ALTER TABLE "payroll_config" ADD COLUMN "stateFlatRates" JSONB;

ALTER TABLE "Client" ADD COLUMN "sutaRateOverride" DECIMAL(6,5);
ALTER TABLE "Client" ADD COLUMN "sutaWageBaseOverride" DECIMAL(12,2);

CREATE TABLE "LocalTaxRule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state" VARCHAR(2) NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(6,5) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LocalTaxRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LocalTaxRule_state_isActive_idx" ON "LocalTaxRule"("state", "isActive");

ALTER TABLE "Associate" ADD COLUMN "localTaxRuleId" UUID;
ALTER TABLE "Associate" ADD CONSTRAINT "Associate_localTaxRuleId_fkey"
    FOREIGN KEY ("localTaxRuleId") REFERENCES "LocalTaxRule"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollItem" ADD COLUMN "localWithholding" DECIMAL(12,2) NOT NULL DEFAULT 0;
