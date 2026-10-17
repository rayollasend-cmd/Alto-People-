-- The floor (field roles, 2026-10).

-- An incident filed from the floor carries the photo the supervisor took.
ALTER TABLE "OshaIncident" ADD COLUMN "photoKey" TEXT;

-- A watch-only floor supervisor raises what they see — a no-show, a hazard —
-- and their shift supervisor acknowledges it. Scalar ids, no foreign keys:
-- the flag outlives the shift it was about.
CREATE TYPE "FloorFlagKind" AS ENUM ('NO_SHOW', 'HAZARD', 'OTHER');
CREATE TYPE "FloorFlagStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED');

CREATE TABLE "FloorFlag" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "clientId" UUID NOT NULL,
  "locationId" UUID,
  "kind" "FloorFlagKind" NOT NULL,
  "associateId" UUID,
  "shiftId" UUID,
  "note" VARCHAR(500) NOT NULL,
  "raisedById" UUID NOT NULL,
  "status" "FloorFlagStatus" NOT NULL DEFAULT 'OPEN',
  "acknowledgedById" UUID,
  "acknowledgedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FloorFlag_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FloorFlag_tenantId_clientId_status_createdAt_idx"
  ON "FloorFlag"("tenantId", "clientId", "status", "createdAt" DESC);
