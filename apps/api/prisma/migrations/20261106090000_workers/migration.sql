-- Brief 1D-1: a worker is not assumed to be a person. Additive: two tables,
-- two nullable columns. Every existing associate becomes a PERSON worker
-- whose owner is their manager's account, else the first org-wide admin;
-- every assigned shift gets its worker. Person-specific tables keep their
-- foreign keys to Associate.

CREATE TYPE "WorkerType" AS ENUM ('PERSON', 'AGENT', 'ROBOT');
CREATE TYPE "WorkerStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED');

CREATE TABLE "Worker" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "WorkerType" NOT NULL,
    "associateId" UUID,
    "name" VARCHAR(160) NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'ONBOARDING',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" VARCHAR(2000),
    "createdById" UUID,
    "offboardedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Worker_associateId_key" ON "Worker"("associateId");
CREATE INDEX "Worker_type_status_idx" ON "Worker"("type", "status");
CREATE INDEX "Worker_ownerUserId_idx" ON "Worker"("ownerUserId");

ALTER TABLE "Worker" ADD CONSTRAINT "Worker_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WorkerAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workerId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "startedAt" DATE NOT NULL,
    "endedAt" DATE,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkerAssignment_workerId_endedAt_idx" ON "WorkerAssignment"("workerId", "endedAt");
CREATE INDEX "WorkerAssignment_locationId_endedAt_idx" ON "WorkerAssignment"("locationId", "endedAt");

ALTER TABLE "WorkerAssignment" ADD CONSTRAINT "WorkerAssignment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkerAssignment" ADD CONSTRAINT "WorkerAssignment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Shift" ADD COLUMN "workerId" UUID;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Shift_workerId_startsAt_idx" ON "Shift"("workerId", "startsAt");

ALTER TABLE "AuditLog" ADD COLUMN "workerId" UUID;

-- Backfill: one PERSON worker per associate. The owner is the manager's
-- account when the manager has one, else the longest-standing active
-- org-wide admin. With no admin at all (an empty database) nothing is
-- inserted; ensurePersonWorkers fills in once one exists.
WITH default_owner AS (
  SELECT "id" FROM "User"
  WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL
    AND "role" IN ('HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'WORKFORCE_MANAGER', 'MANAGER', 'EXECUTIVE_CHAIRMAN')
  ORDER BY CASE "role" WHEN 'HR_ADMINISTRATOR' THEN 0 WHEN 'OPERATIONS_MANAGER' THEN 1 WHEN 'WORKFORCE_MANAGER' THEN 2 WHEN 'MANAGER' THEN 3 ELSE 4 END, "createdAt"
  LIMIT 1
)
INSERT INTO "Worker" ("associateId", "type", "name", "ownerUserId", "status", "capabilities", "updatedAt")
SELECT
  a."id",
  'PERSON'::"WorkerType",
  left(trim(coalesce(a."firstName", '') || ' ' || coalesce(a."lastName", '')), 160),
  coalesce(mu."id", (SELECT "id" FROM default_owner)),
  CASE
    WHEN a."separatedAt" IS NOT NULL THEN 'OFFBOARDED'::"WorkerStatus"
    WHEN a."deactivatedAt" IS NOT NULL THEN 'SUSPENDED'::"WorkerStatus"
    ELSE 'ACTIVE'::"WorkerStatus"
  END,
  ARRAY[]::TEXT[],
  CURRENT_TIMESTAMP
FROM "Associate" a
LEFT JOIN "User" mu ON mu."associateId" = a."managerId" AND mu."status" = 'ACTIVE' AND mu."deletedAt" IS NULL
WHERE a."deletedAt" IS NULL
  AND coalesce(mu."id", (SELECT "id" FROM default_owner)) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Worker" w WHERE w."associateId" = a."id");

UPDATE "Shift" s
SET "workerId" = w."id"
FROM "Worker" w
WHERE w."associateId" = s."assignedAssociateId" AND s."workerId" IS NULL;
