-- Tier-2 — tip pools fold into payroll runs as TIPS earnings.
ALTER TABLE "TipPool" ADD COLUMN "paidPayrollRunId" UUID;
