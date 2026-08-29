-- Store Ops closed loop + metric identity + follow-up lineage.

CREATE TYPE "OpsFollowUpOn" AS ENUM ('NO', 'NO_OR_PARTIAL', 'OUT_OF_RANGE');
ALTER TYPE "OpsTaskSource" ADD VALUE IF NOT EXISTS 'FOLLOWUP';

ALTER TABLE "OpsSopTemplateTask"
  ADD COLUMN "metricKey" VARCHAR(60),
  ADD COLUMN "unit" VARCHAR(30),
  ADD COLUMN "followUpOn" "OpsFollowUpOn",
  ADD COLUMN "followUpRequirePhoto" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "followUpTaskTitle" VARCHAR(300);

ALTER TABLE "OpsTask"
  ADD COLUMN "metricKey" VARCHAR(60),
  ADD COLUMN "unit" VARCHAR(30),
  ADD COLUMN "followUpOn" "OpsFollowUpOn",
  ADD COLUMN "followUpRequirePhoto" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "followUpTaskTitle" VARCHAR(300),
  ADD COLUMN "parentTaskId" UUID;

ALTER TABLE "OpsTask" ADD CONSTRAINT "OpsTask_parentTaskId_fkey"
  FOREIGN KEY ("parentTaskId") REFERENCES "OpsTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
