-- Regions: the command center tier above the store. A store rolls up to a
-- region; a portal account with a region (and no client) sees every store
-- in it.

CREATE TABLE "Region" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Region_deletedAt_idx" ON "Region"("deletedAt");

ALTER TABLE "Location" ADD COLUMN "regionId" UUID;
ALTER TABLE "Location" ADD CONSTRAINT "Location_regionId_fkey"
    FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "regionId" UUID;
ALTER TABLE "User" ADD CONSTRAINT "User_regionId_fkey"
    FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
