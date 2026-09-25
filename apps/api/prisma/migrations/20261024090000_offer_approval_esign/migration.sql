-- Offers that are approved, signed, and written from a template.
--
-- An offer was a record and a plain-text email. Nothing checked its pay
-- against the client's band, the candidate "accepted" by replying and a
-- recruiter clicking Accepted on their behalf, and nothing was signed.
--
--   PENDING_APPROVAL  pay outside the band: held until someone other than
--                     whoever drafted it approves (or declines) it.
--   accept token      the candidate's private link to read the letter and
--                     sign it; only its sha256 is stored.
--   signed*           who signed, when, from where, and the signed PDF
--                     with its hash.

ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'OFFER_APPROVAL_REQUESTED';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'OFFER_APPROVED';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'OFFER_APPROVAL_DECLINED';

ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "approvalNote" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "approvedById" UUID;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMPTZ(6);
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "approvalDeclinedReason" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "acceptTokenHash" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "signedName" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "signedAt" TIMESTAMPTZ(6);
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "signedIp" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "signedUserAgent" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "signedPdfKey" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "signedPdfHash" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "declineReason" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Offer_acceptTokenHash_key" ON "Offer" ("acceptTokenHash");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Offer_approvedById_fkey') THEN
    ALTER TABLE "Offer"
      ADD CONSTRAINT "Offer_approvedById_fkey"
      FOREIGN KEY ("approvedById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
