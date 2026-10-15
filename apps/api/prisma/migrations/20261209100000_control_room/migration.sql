-- Brief 3-3: the hybrid season planner reads demand as tasks, and the task
-- policy carries the robot utilisation and the backup-crew ratio the mix uses.
ALTER TABLE "SeasonPlanSite" ADD COLUMN "taskDemand" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "WorkTaskPolicy" ADD COLUMN "robotUtilizationPct" INTEGER NOT NULL DEFAULT 70;
ALTER TABLE "WorkTaskPolicy" ADD COLUMN "backupCrewRatioPct" INTEGER NOT NULL DEFAULT 25;
