-- Tier-1 — auditable recipient-copy distribution on tax forms.
ALTER TABLE "TaxForm" ADD COLUMN "recipientCopySentAt" TIMESTAMPTZ(6);
