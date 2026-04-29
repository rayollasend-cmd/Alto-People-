-- Wave 1.2 — Per-item earning lines (REGULAR / OVERTIME / HOLIDAY / etc.)

-- CreateEnum
CREATE TYPE "PayrollEarningKind" AS ENUM (
  'REGULAR',
  'OVERTIME',
  'DOUBLE_TIME',
  'HOLIDAY',
  'SICK',
  'VACATION',
  'BONUS',
  'COMMISSION',
  'TIPS',
  'REIMBURSEMENT'
);

-- CreateTable
CREATE TABLE "PayrollItemEarning" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payrollItemId" UUID NOT NULL,
    "kind" "PayrollEarningKind" NOT NULL,
    "hours" DECIMAL(8, 2),
    "rate" DECIMAL(8, 2),
    "amount" DECIMAL(12, 2) NOT NULL,
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollItemEarning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollItemEarning_payrollItemId_idx" ON "PayrollItemEarning"("payrollItemId");

-- AddForeignKey
ALTER TABLE "PayrollItemEarning" ADD CONSTRAINT "PayrollItemEarning_payrollItemId_fkey"
  FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
