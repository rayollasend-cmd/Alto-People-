-- Phase 127 — Tuition reimbursement. Associates submit course-by-course
-- requests with a receipt and (after term) a grade; HR approves and a
-- payroll process pays out. Distinct from Phase 97 reimbursements (which
-- is for expenses) — tuition has its own approval flow, IRS rules
-- (Section 127), and reporting needs.
CREATE TYPE "TuitionStatus" AS ENUM (
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'PAID'
);

CREATE TABLE "TuitionRequest" (
  "id"            UUID            NOT NULL DEFAULT gen_random_uuid(),
  "associateId"   UUID            NOT NULL,
  "schoolName"    TEXT            NOT NULL,
  "programName"   TEXT,
  "courseName"    TEXT            NOT NULL,
  "termStartDate" DATE            NOT NULL,
  "termEndDate"   DATE            NOT NULL,
  "amount"        DECIMAL(10, 2)  NOT NULL,
  "currency"      VARCHAR(3)      NOT NULL DEFAULT 'USD',
  "status"        "TuitionStatus" NOT NULL DEFAULT 'SUBMITTED',
  "receiptUrl"    TEXT,
  "gradeReceived" TEXT,
  "reviewedById"  UUID,
  "reviewedAt"    TIMESTAMPTZ(6),
  "reviewerNotes" TEXT,
  "paidAt"        TIMESTAMPTZ(6),
  "paidById"      UUID,
  "createdAt"     TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "TuitionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TuitionRequest_associateId_idx" ON "TuitionRequest"("associateId");
CREATE INDEX "TuitionRequest_status_idx" ON "TuitionRequest"("status");

ALTER TABLE "TuitionRequest" ADD CONSTRAINT "TuitionRequest_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TuitionRequest" ADD CONSTRAINT "TuitionRequest_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TuitionRequest" ADD CONSTRAINT "TuitionRequest_paidById_fkey"
  FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
