-- I-9: explicit "documents submitted for HR review" timestamp set by the
-- associate after Section 1 + at least one supporting document. Lets the
-- onboarding checklist transition from PENDING → IN_PROGRESS so the
-- associate gets visible confirmation that the ball is now in HR's court,
-- and gives HR a concrete trigger to triage Section 2.

ALTER TABLE "I9Verification"
  ADD COLUMN "documentsSubmittedAt" TIMESTAMPTZ(6);
