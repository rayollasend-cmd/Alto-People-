-- Phase 108 — Employee asset tracking.
--
-- Each physical asset (laptop, phone, badge, key, vehicle) has a row
-- in Asset. Assignments are versioned in AssetAssignment so we have a
-- full audit trail of who held what when. The "currently assigned"
-- check is simply: does the asset have an AssetAssignment with NULL
-- returnedAt? A partial unique index enforces at-most-one open
-- assignment per asset.

CREATE TYPE "AssetKind" AS ENUM (
    'LAPTOP',
    'PHONE',
    'TABLET',
    'BADGE',
    'KEY',
    'VEHICLE',
    'UNIFORM',
    'OTHER'
);

CREATE TYPE "AssetStatus" AS ENUM (
    'AVAILABLE',
    'ASSIGNED',
    'RETIRED',
    'LOST',
    'IN_REPAIR'
);

CREATE TABLE "Asset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "AssetKind" NOT NULL,
    "label" TEXT NOT NULL,
    "serial" TEXT,
    "model" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
    "purchasedAt" DATE,
    "purchasePrice" NUMERIC(12,2),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- Serials are usually unique within a kind (a manufacturer's serial),
-- but two different kinds may share a number. Make the partial unique
-- conditional so blank serials don't conflict.
CREATE UNIQUE INDEX "Asset_kind_serial_key"
    ON "Asset"("kind", "serial")
    WHERE "serial" IS NOT NULL;

CREATE INDEX "Asset_status_idx" ON "Asset"("status");
CREATE INDEX "Asset_kind_idx" ON "Asset"("kind");

CREATE TABLE "AssetAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assetId" UUID NOT NULL,
    "associateId" UUID NOT NULL,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" UUID,
    "returnedAt" TIMESTAMPTZ(6),
    "returnedById" UUID,
    "returnNotes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AssetAssignment_pkey" PRIMARY KEY ("id")
);

-- At most one open (returnedAt IS NULL) assignment per asset.
CREATE UNIQUE INDEX "AssetAssignment_open_idx"
    ON "AssetAssignment"("assetId")
    WHERE "returnedAt" IS NULL;

CREATE INDEX "AssetAssignment_associateId_idx"
    ON "AssetAssignment"("associateId");

ALTER TABLE "AssetAssignment"
    ADD CONSTRAINT "AssetAssignment_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssetAssignment"
    ADD CONSTRAINT "AssetAssignment_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssetAssignment"
    ADD CONSTRAINT "AssetAssignment_assignedById_fkey"
    FOREIGN KEY ("assignedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AssetAssignment"
    ADD CONSTRAINT "AssetAssignment_returnedById_fkey"
    FOREIGN KEY ("returnedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
