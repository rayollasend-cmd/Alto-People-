-- Phase 97 — Spend management: expense reports + reimbursements.
-- An associate submits a Reimbursement (one or more line items, each
-- with optional receipt). HR/Manager approves; on approval the total
-- flows into the next payroll run as a non-taxable add. Mileage uses a
-- per-mile rate × miles instead of a receipt amount.

CREATE TYPE "ReimbursementStatus" AS ENUM (
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'PAID'
);

CREATE TYPE "ExpenseLineKind" AS ENUM (
  'RECEIPT',
  'MILEAGE',
  'PER_DIEM',
  'OTHER'
);

CREATE TABLE "Reimbursement" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"  UUID NOT NULL,
  "title"        TEXT NOT NULL,
  "description"  TEXT,
  "totalAmount"  DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "currency"     VARCHAR(3) NOT NULL DEFAULT 'USD',
  "status"       "ReimbursementStatus" NOT NULL DEFAULT 'DRAFT',
  "submittedAt"  TIMESTAMPTZ(6),
  "decidedAt"    TIMESTAMPTZ(6),
  "decidedById"  UUID,
  "rejectionReason" TEXT,
  -- When PAID: the payroll run that included it.
  "paidPayrollRunId" UUID,
  "paidAt"       TIMESTAMPTZ(6),
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Reimbursement_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "Reimbursement_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "Reimbursement_paidPayrollRunId_fkey"
    FOREIGN KEY ("paidPayrollRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL
);
CREATE INDEX "Reimbursement_associateId_status_idx"
  ON "Reimbursement" ("associateId", "status");
CREATE INDEX "Reimbursement_status_idx" ON "Reimbursement" ("status");

CREATE TABLE "ExpenseLine" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reimbursementId"  UUID NOT NULL,
  "kind"             "ExpenseLineKind" NOT NULL,
  "description"      TEXT NOT NULL,
  "incurredOn"       DATE NOT NULL,
  "amount"           DECIMAL(10, 2) NOT NULL,
  -- For mileage: total miles × rate, output captured here. For receipt:
  -- the actual receipt total. For per_diem: rate × days.
  "miles"            DECIMAL(8, 2),
  "ratePerMile"      DECIMAL(6, 4),
  "receiptUrl"       TEXT,
  "merchant"         TEXT,
  "category"         TEXT, -- e.g. 'Travel', 'Meals'
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ExpenseLine_reimbursementId_fkey"
    FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement"("id") ON DELETE CASCADE,
  CONSTRAINT "ExpenseLine_amount_check" CHECK ("amount" >= 0)
);
CREATE INDEX "ExpenseLine_reimbursementId_idx"
  ON "ExpenseLine" ("reimbursementId");
