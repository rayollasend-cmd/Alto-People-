-- Phase 103 — Kiosk anomaly review queue.
--
-- Flagged punches (face mismatch today, more sources later) sit in a
-- PENDING state for HR / manager review. Approve = leave the TimeEntry
-- alone. Reject = void the TimeEntry (the punch was likely a buddy
-- punch or impostor — we don't want it counting toward payable hours).
--
-- reviewStatus is NULL for normal punches that don't need review,
-- preserving query simplicity (`WHERE reviewStatus = 'PENDING'`).

CREATE TYPE "KioskPunchReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "KioskPunch"
    ADD COLUMN "reviewStatus" "KioskPunchReviewStatus",
    ADD COLUMN "reviewedById" UUID,
    ADD COLUMN "reviewedAt" TIMESTAMPTZ(6),
    ADD COLUMN "reviewNotes" TEXT;

ALTER TABLE "KioskPunch"
    ADD CONSTRAINT "KioskPunch_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial index — fast lookups for the review queue.
CREATE INDEX "KioskPunch_reviewStatus_idx"
    ON "KioskPunch"("reviewStatus")
    WHERE "reviewStatus" IS NOT NULL;
