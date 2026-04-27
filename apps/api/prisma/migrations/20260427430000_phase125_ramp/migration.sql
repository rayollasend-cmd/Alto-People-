-- Phase 125 — New-hire ramp plans (30/60/90/180). One plan per associate at
-- a time (partial unique index on associateId WHERE NOT archivedAt). Each
-- plan has many RampMilestones at different day checkpoints.
CREATE TYPE "RampMilestoneStatus" AS ENUM (
  'PENDING',
  'ON_TRACK',
  'ACHIEVED',
  'MISSED'
);

CREATE TABLE "RampPlan" (
  "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
  "associateId" UUID            NOT NULL,
  "startDate"   DATE            NOT NULL,
  "managerId"   UUID,
  "notes"       TEXT,
  "archivedAt"  TIMESTAMPTZ(6),
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "RampPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RampPlan_associateId_idx" ON "RampPlan"("associateId");
CREATE UNIQUE INDEX "RampPlan_active_per_associate_idx"
  ON "RampPlan"("associateId")
  WHERE "archivedAt" IS NULL;

ALTER TABLE "RampPlan" ADD CONSTRAINT "RampPlan_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RampPlan" ADD CONSTRAINT "RampPlan_managerId_fkey"
  FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RampPlan" ADD CONSTRAINT "RampPlan_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RampMilestone" (
  "id"            UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "planId"        UUID                  NOT NULL,
  "dayCheckpoint" INTEGER               NOT NULL,
  "title"         TEXT                  NOT NULL,
  "description"   TEXT,
  "status"        "RampMilestoneStatus" NOT NULL DEFAULT 'PENDING',
  "achievedAt"    TIMESTAMPTZ(6),
  "notes"         TEXT,
  "createdAt"     TIMESTAMPTZ(6)        NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ(6)        NOT NULL,
  CONSTRAINT "RampMilestone_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RampMilestone_planId_idx" ON "RampMilestone"("planId", "dayCheckpoint");

ALTER TABLE "RampMilestone" ADD CONSTRAINT "RampMilestone_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "RampPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
