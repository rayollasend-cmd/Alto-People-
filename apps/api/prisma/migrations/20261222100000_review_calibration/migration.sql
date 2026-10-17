-- Review calibration: HR can move a draft review's rating after comparing
-- reviewers, keeping the reviewer's own rating and the reason beside it.
ALTER TABLE "PerformanceReview"
  ADD COLUMN "originalRating"   INTEGER,
  ADD COLUMN "calibrationNote"  VARCHAR(1000),
  ADD COLUMN "calibratedById"   UUID,
  ADD COLUMN "calibratedAt"     TIMESTAMPTZ(6);

ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "PerformanceReview_calibratedById_fkey"
  FOREIGN KEY ("calibratedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
