-- The report builder's computed entities (lib/reportComputed): pay changes,
-- time to fill and overtime by store.
ALTER TYPE "ReportEntity" ADD VALUE IF NOT EXISTS 'PAY_CHANGE';
ALTER TYPE "ReportEntity" ADD VALUE IF NOT EXISTS 'TIME_TO_FILL';
ALTER TYPE "ReportEntity" ADD VALUE IF NOT EXISTS 'OVERTIME';
