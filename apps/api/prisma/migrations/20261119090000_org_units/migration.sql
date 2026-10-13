-- Brief 2-1b, step 5: the organizational hierarchy. Additive. Region and
-- CostCenter rows are mirrored into OrgUnit and the four scope columns are
-- backfilled; the old tables and columns stay in step until a later drop.

DO $$ BEGIN
  CREATE TYPE "OrgUnitType" AS ENUM ('DIVISION', 'REGION', 'BUSINESS_UNIT', 'COST_CENTER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "OrgUnit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "type" "OrgUnitType" NOT NULL,
  "parentId" UUID,
  "name" VARCHAR(160) NOT NULL,
  "code" VARCHAR(40),
  "glCode" VARCHAR(40),
  "path" VARCHAR(2000) NOT NULL,
  "clientId" UUID,
  "legacyRegionId" UUID,
  "legacyCostCenterId" UUID,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "OrgUnit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrgUnit_legacyRegionId_key" ON "OrgUnit"("legacyRegionId");
CREATE UNIQUE INDEX IF NOT EXISTS "OrgUnit_legacyCostCenterId_key" ON "OrgUnit"("legacyCostCenterId");
CREATE INDEX IF NOT EXISTS "OrgUnit_tenantId_type_idx" ON "OrgUnit"("tenantId", "type");
CREATE INDEX IF NOT EXISTS "OrgUnit_parentId_idx" ON "OrgUnit"("parentId");
CREATE INDEX IF NOT EXISTS "OrgUnit_path_idx" ON "OrgUnit"("path");
CREATE INDEX IF NOT EXISTS "OrgUnit_deletedAt_idx" ON "OrgUnit"("deletedAt");
DO $$ BEGIN
  ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_legacyRegionId_fkey" FOREIGN KEY ("legacyRegionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_legacyCostCenterId_fkey" FOREIGN KEY ("legacyCostCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Location"  ADD COLUMN IF NOT EXISTS "orgUnitId" UUID;
ALTER TABLE "User"      ADD COLUMN IF NOT EXISTS "orgUnitId" UUID;
ALTER TABLE "Associate" ADD COLUMN IF NOT EXISTS "orgUnitId" UUID;
ALTER TABLE "Position"  ADD COLUMN IF NOT EXISTS "orgUnitId" UUID;
CREATE INDEX IF NOT EXISTS "Location_orgUnitId_idx" ON "Location"("orgUnitId");
CREATE INDEX IF NOT EXISTS "User_orgUnitId_idx" ON "User"("orgUnitId");
CREATE INDEX IF NOT EXISTS "Associate_orgUnitId_idx" ON "Associate"("orgUnitId");
CREATE INDEX IF NOT EXISTS "Position_orgUnitId_idx" ON "Position"("orgUnitId");
DO $$ BEGIN
  ALTER TABLE "Location" ADD CONSTRAINT "Location_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "User" ADD CONSTRAINT "User_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Associate" ADD CONSTRAINT "Associate_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Position" ADD CONSTRAINT "Position_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every Region is a REGION unit at the root; its path is its own id.
INSERT INTO "OrgUnit" ("id", "tenantId", "type", "name", "path", "legacyRegionId", "createdAt", "updatedAt", "deletedAt")
SELECT gen_random_uuid(), r."tenantId", 'REGION', r."name", '', r."id", r."createdAt", r."updatedAt", r."deletedAt"
FROM "Region" r
WHERE NOT EXISTS (SELECT 1 FROM "OrgUnit" u WHERE u."legacyRegionId" = r."id");
UPDATE "OrgUnit" SET "path" = '/' || "id"::text WHERE "path" = '' AND "legacyRegionId" IS NOT NULL;

-- Every CostCenter is a COST_CENTER unit at the root, keeping its client.
INSERT INTO "OrgUnit" ("id", "tenantId", "type", "name", "code", "path", "clientId", "legacyCostCenterId", "createdAt", "updatedAt", "deletedAt")
SELECT gen_random_uuid(), c."tenantId", 'COST_CENTER', c."name", c."code", '', c."clientId", c."id", c."createdAt", c."updatedAt", c."deletedAt"
FROM "CostCenter" c
WHERE NOT EXISTS (SELECT 1 FROM "OrgUnit" u WHERE u."legacyCostCenterId" = c."id");
UPDATE "OrgUnit" SET "path" = '/' || "id"::text WHERE "path" = '' AND "legacyCostCenterId" IS NOT NULL;

-- The four scope columns follow the mirrors.
UPDATE "Location" l SET "orgUnitId" = u."id" FROM "OrgUnit" u WHERE l."regionId" IS NOT NULL AND u."legacyRegionId" = l."regionId" AND l."orgUnitId" IS NULL;
UPDATE "User" us SET "orgUnitId" = u."id" FROM "OrgUnit" u WHERE us."regionId" IS NOT NULL AND u."legacyRegionId" = us."regionId" AND us."orgUnitId" IS NULL;
UPDATE "Associate" a SET "orgUnitId" = u."id" FROM "OrgUnit" u WHERE a."costCenterId" IS NOT NULL AND u."legacyCostCenterId" = a."costCenterId" AND a."orgUnitId" IS NULL;
UPDATE "Position" p SET "orgUnitId" = u."id" FROM "OrgUnit" u WHERE p."costCenterId" IS NOT NULL AND u."legacyCostCenterId" = p."costCenterId" AND p."orgUnitId" IS NULL;
