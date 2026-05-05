-- Gap 1 — extend the per-recipient CHECK on TaxForm so a W-2c can have an
-- associateId (it inherits the recipient from the W-2 it amends). Without
-- this fix the W-2c create route fails with check constraint violation
-- 23514 because the original constraint enumerates the kinds explicitly
-- and W2C wasn't in the list.

ALTER TABLE "TaxForm" DROP CONSTRAINT "TaxForm_recipient_check";

ALTER TABLE "TaxForm"
  ADD CONSTRAINT "TaxForm_recipient_check"
  CHECK (
    ("kind"::text IN ('W2', 'W2C', 'F1099_NEC') AND "associateId" IS NOT NULL)
    OR ("kind"::text IN ('F941', 'F940') AND "associateId" IS NULL)
  );
