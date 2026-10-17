-- The per-recipient check on TaxForm enumerates kinds: a 1095-C names an
-- employee, a 1094-C (the transmittal) names none — like the 1099-MISC,
-- which the earlier list also left out.
ALTER TABLE "TaxForm" DROP CONSTRAINT IF EXISTS "TaxForm_recipient_check";
ALTER TABLE "TaxForm"
  ADD CONSTRAINT "TaxForm_recipient_check"
  CHECK (
    ("kind"::text IN ('W2', 'W2C', 'F1099_NEC', 'F1099_MISC', 'F1095C') AND "associateId" IS NOT NULL)
    OR ("kind"::text IN ('F941', 'F940', 'F1094C') AND "associateId" IS NULL)
  );
