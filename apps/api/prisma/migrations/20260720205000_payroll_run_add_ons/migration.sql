-- Tier-2 — manual earning lines (bonus/commission/tips/holiday/PTO) on draft runs.
CREATE TABLE "PayrollRunAddOn" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payrollRunId" UUID NOT NULL,
    "associateId" UUID NOT NULL,
    "kind" "PayrollEarningKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "hours" DECIMAL(8,2),
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRunAddOn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayrollRunAddOn_payrollRunId_idx" ON "PayrollRunAddOn"("payrollRunId");
CREATE INDEX "PayrollRunAddOn_associateId_idx" ON "PayrollRunAddOn"("associateId");

ALTER TABLE "PayrollRunAddOn" ADD CONSTRAINT "PayrollRunAddOn_payrollRunId_fkey"
    FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollRunAddOn" ADD CONSTRAINT "PayrollRunAddOn_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollRunAddOn" ADD CONSTRAINT "PayrollRunAddOn_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
