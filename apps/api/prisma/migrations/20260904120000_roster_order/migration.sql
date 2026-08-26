-- Per-client custom row order for the scheduling grid.
CREATE TABLE "SchedulingRosterOrder" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "associateId" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SchedulingRosterOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SchedulingRosterOrder_clientId_associateId_key"
  ON "SchedulingRosterOrder"("clientId", "associateId");
CREATE INDEX "SchedulingRosterOrder_clientId_position_idx"
  ON "SchedulingRosterOrder"("clientId", "position");
