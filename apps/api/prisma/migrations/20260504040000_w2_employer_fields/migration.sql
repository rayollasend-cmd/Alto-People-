-- Gap 1 — W-2 generation: employer block fields on Client + immutability
-- hash on TaxForm. All adds are NULL-able / defaulted, safe to run on prod.

-- Client gets the fields the W-2 employer block needs.  Existing Client
-- rows continue to work; HR fills these in before generating W-2s.
ALTER TABLE "Client"
  ADD COLUMN "legalName"    VARCHAR(255),
  ADD COLUMN "ein"          VARCHAR(20),
  ADD COLUMN "addressLine1" VARCHAR(255),
  ADD COLUMN "addressLine2" VARCHAR(255),
  ADD COLUMN "city"         VARCHAR(120),
  ADD COLUMN "zip"          VARCHAR(10);

-- TaxForm: stamp sha256 of the rendered PDF on first download (matching
-- PayrollItem.paystubHash). Subsequent renders verify identical bytes.
ALTER TABLE "TaxForm"
  ADD COLUMN "pdfHash" VARCHAR(64);
