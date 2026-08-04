-- Scheduled reports now actually run and deliver (lib/reportScheduleRunner.ts).
-- Record the outcome of the most recent delivery attempt on the schedule row
-- so admins can see "SUCCESS" / "PARTIAL (n/m delivered)" / "FAILED: <reason>"
-- next to lastRunAt. Null until the first run.

ALTER TABLE "ReportSchedule" ADD COLUMN "lastStatus" TEXT;
