-- Phase 132 — Goal → PIP → Review linkage.
--
-- Adds nullable FK columns so the performance loop is queryable end-to-end
-- without rebuilding all three modules.
--
--   Pip.sourceGoalId            → the at-risk Goal that triggered this PIP
--   PerformanceReview.sourcePipId → the closed Pip this review is summarising
--
-- Both are nullable + ON DELETE SET NULL so deleting the upstream record
-- doesn't cascade and we just lose the breadcrumb.

ALTER TABLE "Pip"
  ADD COLUMN "sourceGoalId" UUID;

ALTER TABLE "Pip"
  ADD CONSTRAINT "Pip_sourceGoalId_fkey"
  FOREIGN KEY ("sourceGoalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Pip_sourceGoalId_idx" ON "Pip"("sourceGoalId");

ALTER TABLE "PerformanceReview"
  ADD COLUMN "sourcePipId" UUID;

ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "PerformanceReview_sourcePipId_fkey"
  FOREIGN KEY ("sourcePipId") REFERENCES "Pip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PerformanceReview_sourcePipId_idx" ON "PerformanceReview"("sourcePipId");
