-- Phase 43 — annual entitlements for VACATION / PTO / etc.
-- SICK accrual remains per-worked-hour (Phase 26) and does NOT need an
-- entitlement row; it accrues from TimeEntry approval. Other categories
-- get an annual lump-sum granted at the reset anchor date, capped at
-- carryoverMaxMinutes when rolling into the new year.

ALTER TYPE "TimeOffLedgerReason" ADD VALUE IF NOT EXISTS 'CARRYOVER_FORFEIT';
ALTER TYPE "TimeOffLedgerReason" ADD VALUE IF NOT EXISTS 'ANNUAL_GRANT';

CREATE TABLE "TimeOffEntitlement" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"         UUID NOT NULL,
  "category"            "TimeOffCategory" NOT NULL,
  "annualMinutes"       INTEGER NOT NULL,
  "carryoverMaxMinutes" INTEGER NOT NULL DEFAULT 0,
  "policyAnchorDate"    DATE NOT NULL DEFAULT DATE '2000-01-01',
  "lastGrantedAt"       DATE,
  "createdAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"           TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TimeOffEntitlement_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "TimeOffEntitlement_associateId_category_key"
  ON "TimeOffEntitlement" ("associateId", "category");
CREATE INDEX "TimeOffEntitlement_associateId_idx"
  ON "TimeOffEntitlement" ("associateId");
