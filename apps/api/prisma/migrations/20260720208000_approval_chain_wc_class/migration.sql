-- Tier-3 — four-eyes payroll approval + workers-comp classification.
ALTER TABLE "PayrollRun" ADD COLUMN "approvedById" UUID;
ALTER TABLE "PayrollRun" ADD COLUMN "approvedAt" TIMESTAMPTZ(6);
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Associate" ADD COLUMN "wcClassCodeId" UUID;
ALTER TABLE "Associate" ADD CONSTRAINT "Associate_wcClassCodeId_fkey"
    FOREIGN KEY ("wcClassCodeId") REFERENCES "WcClassCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
