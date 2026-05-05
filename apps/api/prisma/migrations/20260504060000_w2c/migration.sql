-- Gap 1 — W-2c (W-2 correction) support.
--
-- Adds W2C to the TaxFormKind enum and an amendsTaxFormId column on
-- TaxForm pointing at the original W-2 the W-2c corrects. The original
-- W-2 stays in the table as FILED — IRS rule: you don't void a W-2 you
-- already filed, you correct it via a W-2c. We flip its status to
-- AMENDED at create time so the UI can hide it from the active list.

ALTER TYPE "TaxFormKind" ADD VALUE IF NOT EXISTS 'W2C';

-- Defer the column add to a separate statement: Postgres requires the
-- new enum value to be committed before another DDL in the same
-- transaction can reference it (the same constraint Gap 10 hit on
-- ReimbursementStatus). Prisma migrate runs each migration as one txn,
-- so the W2C value won't be referenced inside this file — only the
-- column add. The first row using W2C lands later from the create-W2c
-- route.

ALTER TABLE "TaxForm"
  ADD COLUMN "amendsTaxFormId" UUID;

ALTER TABLE "TaxForm"
  ADD CONSTRAINT "TaxForm_amends_taxform_fkey"
  FOREIGN KEY ("amendsTaxFormId") REFERENCES "TaxForm"("id") ON DELETE SET NULL;

-- A W-2c MUST point at an original W-2; non-W2c forms MUST NOT.
ALTER TABLE "TaxForm"
  ADD CONSTRAINT "TaxForm_w2c_amends_required_chk"
  CHECK (
    ("kind"::text = 'W2C' AND "amendsTaxFormId" IS NOT NULL)
    OR
    ("kind"::text <> 'W2C' AND "amendsTaxFormId" IS NULL)
  );

CREATE INDEX "TaxForm_amends_idx" ON "TaxForm" ("amendsTaxFormId");
