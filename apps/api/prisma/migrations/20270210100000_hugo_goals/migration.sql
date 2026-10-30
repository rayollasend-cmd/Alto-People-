-- Hugo's goals (Muse phase 3, lib/hugoGoals). A goal is a HugoTask of kind
-- 'GOAL' (a VARCHAR code — no enum to change). Two additions, no rewrite of
-- live rows: every existing task keeps parentId NULL.
--   * HugoTask.parentId: a watch or an ask a goal started on an approved step.
--     Its news wakes the goal; stopping the goal stops it. A deleted parent
--     leaves the child standing (SET NULL).
--   * An index for the organization's goal steps per day (HUGO_GOAL_DAILY_STEPS
--     counts HugoTaskEvent rows with code 'STEP' since the company day began).

ALTER TABLE "HugoTask" ADD COLUMN IF NOT EXISTS "parentId" UUID;

CREATE INDEX IF NOT EXISTS "HugoTask_parentId_idx" ON "HugoTask"("parentId");

CREATE INDEX IF NOT EXISTS "HugoTaskEvent_tenantId_code_createdAt_idx" ON "HugoTaskEvent"("tenantId", "code", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'HugoTask_parentId_fkey') THEN
    ALTER TABLE "HugoTask" ADD CONSTRAINT "HugoTask_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "HugoTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
