-- Gap 11 — Recipient TIN for Form 1099-NEC.
--
-- Contractor associates need their Taxpayer Identification Number on
-- file before we can render Form 1099-NEC: SSN for
-- CONTRACTOR_1099_INDIVIDUAL, EIN for CONTRACTOR_1099_BUSINESS. We
-- store it encrypted at rest the same way W4Submission.ssnEncrypted
-- holds W-2 employee SSNs (PAYOUT_ENCRYPTION_KEY-driven, AES-GCM).
--
-- Why a column on Associate rather than a new W9Submission model:
--   · The TIN is a single field, not a multi-field IRS form like W-4
--   · Contractors don't sign a W-9 in our UI today — finance enters the
--     TIN once at onboarding and we treat it as canonical until updated
--   · A W9Submission model can land later if we ever need the formal
--     audit trail (signed-at, signed-PDF, etc); it would just hang off
--     Associate and override this column
--
-- The W-9 collection UI is a follow-up; this column lets the PDF route
-- and IRS-FIRE generator surface a clean missing_tin error today
-- instead of 500ing on a null read.

ALTER TABLE "Associate"
  ADD COLUMN "tinEncrypted" BYTEA;
