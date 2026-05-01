-- HR uploads result PDFs from external providers (Checkr, drug-test lab,
-- E-Verify) back into the associate's profile so all submitted forms +
-- result documents live in one auditable place. These kinds tag the
-- DocumentRecord rows HR creates via /documents/admin/upload.
ALTER TYPE "DocumentKind" ADD VALUE IF NOT EXISTS 'BACKGROUND_CHECK_RESULT';
ALTER TYPE "DocumentKind" ADD VALUE IF NOT EXISTS 'DRUG_TEST_RESULT';
ALTER TYPE "DocumentKind" ADD VALUE IF NOT EXISTS 'I9_VERIFICATION_RESULT';
