-- SOP blocks carry a due time ("by 9:00 AM"); each run's items carry the
-- real deadline on that shift's clock.
ALTER TABLE "OpsSopTemplateTask" ADD COLUMN "dueTime" VARCHAR(5);
ALTER TABLE "OpsTask" ADD COLUMN "dueAt" TIMESTAMPTZ(6);
