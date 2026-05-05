-- Gap 10 — Reimbursement two-step approval + payroll-fold integration.
--
-- Extends the Phase 97 reimbursement skeleton (Reimbursement / ExpenseLine
-- already exist with single-step approval) into the production-ready flow:
--   DRAFT → SUBMITTED → MANAGER_APPROVED → SETTLED → PAID
--                            │
--                            └─ rejected from any non-terminal state
--
-- Phase 97 used 'APPROVED' for the single-step "decided" state. We rename
-- it to 'SETTLED' so the flow reads correctly: SETTLED is the post-HR
-- queue waiting to be folded into the next REGULAR payroll run, PAID is
-- the post-fold terminal state. MANAGER_APPROVED is the new intermediate.
-- (No production rows exist; Phase 97 was skeletal/unintegrated.)

-- Rename the old 'APPROVED' value to 'SETTLED' (keeps existing route code
-- compiling — call sites are updated alongside this migration).
ALTER TYPE "ReimbursementStatus" RENAME VALUE 'APPROVED' TO 'SETTLED';

-- Add the new intermediate state. Postgres requires the enum extension to
-- happen in its own statement and outside a transaction, but Prisma
-- migrations run each statement individually so this is fine.
ALTER TYPE "ReimbursementStatus" ADD VALUE IF NOT EXISTS 'MANAGER_APPROVED' BEFORE 'SETTLED';

-- Manager-step audit columns. Stamped by POST /reimbursements/:id/manager-
-- approve. SET NULL on user delete so we don't lose the timestamp when an
-- approver is offboarded.
ALTER TABLE "Reimbursement"
  ADD COLUMN "managerApprovedById" UUID,
  ADD COLUMN "managerApprovedAt"   TIMESTAMPTZ(6),
  ADD COLUMN "managerNote"         TEXT;

ALTER TABLE "Reimbursement"
  ADD CONSTRAINT "Reimbursement_managerApprovedById_fkey"
    FOREIGN KEY ("managerApprovedById") REFERENCES "User"("id") ON DELETE SET NULL;

-- HR/Finance settlement-step audit columns. Stamped by POST
-- /reimbursements/:id/settle. The pre-existing decidedById / decidedAt /
-- rejectionReason columns are repurposed as the *rejection* audit
-- (rejection can come from a manager OR HR; they share one set of cols).
ALTER TABLE "Reimbursement"
  ADD COLUMN "settledById" UUID,
  ADD COLUMN "settledAt"   TIMESTAMPTZ(6),
  ADD COLUMN "settleNote"  TEXT;

ALTER TABLE "Reimbursement"
  ADD CONSTRAINT "Reimbursement_settledById_fkey"
    FOREIGN KEY ("settledById") REFERENCES "User"("id") ON DELETE SET NULL;

-- Payroll fold-in link. Stamped by payroll-run creation when a SETTLED
-- row drains into a PayrollItem. Once stamped the row is PAID and can't
-- be folded into a later run. paidPayrollRunId stays for back-compat (it
-- was the run-level link Phase 97 used); new code reads payrollItemId.
ALTER TABLE "Reimbursement"
  ADD COLUMN "payrollItemId" UUID;

ALTER TABLE "Reimbursement"
  ADD CONSTRAINT "Reimbursement_payrollItemId_fkey"
    FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE SET NULL;

-- Receipt-required guard waiver. HR can override the receipt requirement
-- at settle time when a receipt is genuinely lost; the waiver note
-- carries the justification.
ALTER TABLE "Reimbursement"
  ADD COLUMN "receiptWaiverNote" TEXT;

-- State-machine integrity. MANAGER_APPROVED+SETTLED+PAID require the
-- relevant audit pair; REJECTED requires rejection reason.
--
-- Note: Postgres refuses to USE a new enum value in the same transaction
-- it was added, so we cast "status"::text inside the CHECKs to compare as
-- string literals instead of typed enum values. Functionally identical;
-- side-steps the safety check in lib/postgres/src/backend/utils/adt/enum.c.
ALTER TABLE "Reimbursement"
  ADD CONSTRAINT "Reimbursement_manager_approved_chk" CHECK (
    "status"::text NOT IN ('MANAGER_APPROVED', 'SETTLED', 'PAID') OR (
      "managerApprovedById" IS NOT NULL AND "managerApprovedAt" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "Reimbursement_settled_chk" CHECK (
    "status"::text NOT IN ('SETTLED', 'PAID') OR (
      "settledById" IS NOT NULL AND "settledAt" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "Reimbursement_paid_chk" CHECK (
    "status"::text <> 'PAID' OR ("payrollItemId" IS NOT NULL AND "paidAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "Reimbursement_rejected_chk" CHECK (
    "status"::text <> 'REJECTED' OR (
      "decidedById" IS NOT NULL AND
      "decidedAt" IS NOT NULL AND
      "rejectionReason" IS NOT NULL AND
      length(btrim("rejectionReason")) > 0
    )
  );

-- Partial index for "ready to fold into next payroll run". The aggregator
-- queries this scope every run-creation; the partial index keeps it cheap
-- as the Reimbursement table grows. SETTLED was renamed in-place from
-- the pre-existing APPROVED, so it's safely usable in the same txn (only
-- *new* enum values trip the safety check).
CREATE INDEX "Reimbursement_settled_unpaid_idx"
  ON "Reimbursement"("associateId")
  WHERE "status" = 'SETTLED' AND "payrollItemId" IS NULL;

-- Persisted total on PayrollItem so the paystub PDF / drawer can render
-- reimbursements without an extra aggregate. Default 0 keeps existing
-- payroll items unchanged. Reimbursement amounts are added to netPay
-- AFTER taxes / deductions — accountable-plan rule means they never
-- touch grossPay or any wage base.
ALTER TABLE "PayrollItem"
  ADD COLUMN "reimbursementsTotal" DECIMAL(10, 2) NOT NULL DEFAULT 0;

-- Configurable IRS mileage rate. Lives on OrgSetting as a single column
-- so HR can update it when the IRS publishes the new rate (typically
-- announced in December for the next calendar year). Default $0.67/mile
-- matches the 2026 IRS standard mileage rate. Stored as Numeric so the
-- multiplication on the client / aggregator stays exact.
ALTER TABLE "OrgSetting"
  ADD COLUMN "mileageRatePerMile" DECIMAL(8, 4) NOT NULL DEFAULT 0.6700;
