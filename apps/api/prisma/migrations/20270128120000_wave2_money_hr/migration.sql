-- Wave 2 (LEFT-A): money and HR leftovers.

-- The IRS lock-in letter itself, filed in the person's document vault.
ALTER TABLE "W4Submission" ADD COLUMN "lockInLetterDocumentId" UUID;

-- "Message selected" on People: a broadcast to an explicit list of people.
ALTER TABLE "Broadcast" ADD COLUMN "recipientAssociateIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- A skill the person added themselves, pending verification.
ALTER TABLE "AssociateSkill" ADD COLUMN "selfClaimedAt" TIMESTAMPTZ(6);
