-- Gap 3 — Void & amend workflow.
--
-- Adds the schema needed to:
--   1. Void a DISBURSED payroll run (status -> CANCELLED, items -> VOIDED).
--      Money is not clawed back from the rail; the void is a system record
--      correction and a reversing QBO journal entry.
--   2. Amend a DISBURSED run by creating a new linked run (kind=AMENDMENT)
--      whose items carry signed deltas vs. the original. Positive nets
--      flow through the regular disburse path; negative nets create a
--      PendingPayrollDeduction that the next REGULAR run consumes as a
--      post-tax deduction line (rolling across runs until recovered).
--   3. Tag off-cycle runs distinctly (kind=OFF_CYCLE) so dashboards and
--      QBO journal entries can label them clearly.
--   4. Close Gap 8 — `amendsItemId` is the FK that lets the engine sum
--      live YTD across original + amendment items instead of trusting
--      the snapshotted ytdWages column on already-disbursed items.

-- ===== Enums ============================================================

-- CreateEnum
CREATE TYPE "PayrollRunKind" AS ENUM ('REGULAR', 'OFF_CYCLE', 'AMENDMENT');

-- AlterEnum
-- Adds VOIDED to the existing PayrollItemStatus. Items on a voided run
-- transition DISBURSED -> VOIDED so the associate paystub list and YTD
-- recalc both ignore them.
ALTER TYPE "PayrollItemStatus" ADD VALUE 'VOIDED';

-- ===== PayrollRun =======================================================
--
-- Six new columns:
--   kind                — REGULAR / OFF_CYCLE / AMENDMENT (default REGULAR)
--   amendsRunId         — FK to the run this amendment corrects; required
--                          when kind=AMENDMENT (enforced by check below)
--   amendmentReason     — mandatory free-text on AMENDMENT runs; rendered
--                          on the amendment paystub PDF
--   cancelledById       — User who voided the run (cancelledAt already
--                          exists on the model and is now actually written)
--   cancelReason        — mandatory free-text when status=CANCELLED
--   voidJournalEntryId  — QBO JournalEntry.Id of the reversing JE we post
--                          on void (parallel to existing qboJournalEntryId)

-- AlterTable
ALTER TABLE "PayrollRun"
  ADD COLUMN "kind" "PayrollRunKind" NOT NULL DEFAULT 'REGULAR',
  ADD COLUMN "amendsRunId" UUID,
  ADD COLUMN "amendmentReason" TEXT,
  ADD COLUMN "cancelledById" UUID,
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "voidJournalEntryId" VARCHAR(64);

-- AddForeignKey
ALTER TABLE "PayrollRun"
  ADD CONSTRAINT "PayrollRun_amendsRunId_fkey"
    FOREIGN KEY ("amendsRunId") REFERENCES "PayrollRun"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollRun"
  ADD CONSTRAINT "PayrollRun_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheckConstraint
-- AMENDMENT runs must reference an original run AND carry a reason. Empty
-- check on REGULAR / OFF_CYCLE runs (the OR short-circuits true).
ALTER TABLE "PayrollRun"
  ADD CONSTRAINT "PayrollRun_amendment_requires_link"
    CHECK ("kind" <> 'AMENDMENT' OR "amendsRunId" IS NOT NULL);

ALTER TABLE "PayrollRun"
  ADD CONSTRAINT "PayrollRun_amendment_requires_reason"
    CHECK ("kind" <> 'AMENDMENT' OR ("amendmentReason" IS NOT NULL AND length(btrim("amendmentReason")) > 0));

-- CANCELLED runs must carry a void reason so the audit trail and
-- associate-facing copy always have something to display.
ALTER TABLE "PayrollRun"
  ADD CONSTRAINT "PayrollRun_cancelled_requires_reason"
    CHECK ("status" <> 'CANCELLED' OR ("cancelReason" IS NOT NULL AND length(btrim("cancelReason")) > 0));

-- CreateIndex
CREATE INDEX "PayrollRun_kind_idx" ON "PayrollRun"("kind");
CREATE INDEX "PayrollRun_amendsRunId_idx" ON "PayrollRun"("amendsRunId");

-- ===== PayrollItem ======================================================
--
-- Two new columns:
--   voidedAt      — per-item void timestamp; mirrors run.cancelledAt at
--                    void time. Lets paystub PDFs render "VOID" with a date.
--   amendsItemId  — FK to the original item this row corrects; required
--                    when the parent run is kind=AMENDMENT. Application
--                    code enforces that pairing (no DB-level check —
--                    cross-row predicates aren't ergonomic in CHECK).

-- AlterTable
ALTER TABLE "PayrollItem"
  ADD COLUMN "voidedAt" TIMESTAMPTZ(6),
  ADD COLUMN "amendsItemId" UUID;

-- AddForeignKey
-- ON DELETE RESTRICT so an original item cannot be deleted while
-- amendment items still point to it.
ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "PayrollItem_amendsItemId_fkey"
    FOREIGN KEY ("amendsItemId") REFERENCES "PayrollItem"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "PayrollItem_amendsItemId_idx" ON "PayrollItem"("amendsItemId");

-- ===== PendingPayrollDeduction =========================================
--
-- One row per overpayment clawback created when an AMENDMENT run is
-- finalized with a negative-net item. The next REGULAR run for that
-- associate drains pending rows and applies them as a post-tax
-- deduction line on the new paystub. If the associate's net pay is too
-- small to absorb the full deduction, the consumer rolls a residual
-- row forward (same associate, smaller amount) until fully recovered.
--
-- Fields:
--   amount                — magnitude to deduct (always positive)
--   note                  — wizard-supplied explanation; surfaces on
--                            the deduction line
--   sourceAmendmentItemId — FK to the AMENDMENT PayrollItem that
--                            created this deduction
--   appliedRunId          — set when consumed; partial-index key
--   appliedItemId         — the regular-run PayrollItem on which this
--                            deduction was applied (null until consumed)
--   appliedAt             — when consumed

-- CreateTable
CREATE TABLE "PendingPayrollDeduction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "sourceAmendmentItemId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT NOT NULL,
    "appliedRunId" UUID,
    "appliedItemId" UUID,
    "appliedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PendingPayrollDeduction_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PendingPayrollDeduction"
  ADD CONSTRAINT "PendingPayrollDeduction_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PendingPayrollDeduction"
  ADD CONSTRAINT "PendingPayrollDeduction_sourceAmendmentItemId_fkey"
    FOREIGN KEY ("sourceAmendmentItemId") REFERENCES "PayrollItem"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PendingPayrollDeduction"
  ADD CONSTRAINT "PendingPayrollDeduction_appliedRunId_fkey"
    FOREIGN KEY ("appliedRunId") REFERENCES "PayrollRun"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PendingPayrollDeduction"
  ADD CONSTRAINT "PendingPayrollDeduction_appliedItemId_fkey"
    FOREIGN KEY ("appliedItemId") REFERENCES "PayrollItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "PendingPayrollDeduction"
  ADD CONSTRAINT "PendingPayrollDeduction_amount_positive"
    CHECK ("amount" > 0);

-- CreateIndex
-- Partial index — the consumer query is "open deductions for this
-- associate," and once appliedRunId is set the row is history.
CREATE INDEX "PendingPayrollDeduction_associate_open_idx"
  ON "PendingPayrollDeduction"("associateId")
  WHERE "appliedRunId" IS NULL;

CREATE INDEX "PendingPayrollDeduction_sourceAmendmentItemId_idx"
  ON "PendingPayrollDeduction"("sourceAmendmentItemId");
