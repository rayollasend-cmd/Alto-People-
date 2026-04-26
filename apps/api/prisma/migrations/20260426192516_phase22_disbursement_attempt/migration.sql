-- CreateTable
CREATE TABLE "PayrollDisbursementAttempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payrollItemId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalRef" TEXT,
    "failureReason" TEXT,
    "attemptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedById" UUID,

    CONSTRAINT "PayrollDisbursementAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollDisbursementAttempt_payrollItemId_attemptedAt_idx" ON "PayrollDisbursementAttempt"("payrollItemId", "attemptedAt");

-- CreateIndex
CREATE INDEX "PayrollDisbursementAttempt_status_idx" ON "PayrollDisbursementAttempt"("status");

-- AddForeignKey
ALTER TABLE "PayrollDisbursementAttempt" ADD CONSTRAINT "PayrollDisbursementAttempt_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDisbursementAttempt" ADD CONSTRAINT "PayrollDisbursementAttempt_attemptedById_fkey" FOREIGN KEY ("attemptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
