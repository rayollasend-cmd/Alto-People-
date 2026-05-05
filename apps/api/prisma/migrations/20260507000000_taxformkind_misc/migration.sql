-- Gap 11 — Phase 8: 1099-MISC vertical
--
-- Adds F1099_MISC to the TaxFormKind enum so the same TaxForm row
-- shape (amounts JSON, status, taxYear) covers 1099-MISC alongside
-- F1099_NEC. PDF rendering, generate route, bulk-zip, and IRS FIRE
-- e-file all dispatch on this kind.

ALTER TYPE "TaxFormKind" ADD VALUE 'F1099_MISC';
