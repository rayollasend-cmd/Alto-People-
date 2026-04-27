-- Phase 76 — Org hierarchy foundations.
-- Adds Department / CostCenter / JobProfile models, MANAGER role,
-- and the corresponding nullable FK columns on Associate. Everything is
-- additive: existing rows have NULLs and continue to work unchanged.

-- 1. Extend the Role enum.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MANAGER';

-- 2. Department — per-client, optionally nested via parentId.
CREATE TABLE "Department" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID NOT NULL,
  "parentId"    UUID,
  "name"        TEXT NOT NULL,
  "code"        TEXT,
  "description" TEXT,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "Department_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "Department_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE SET NULL
);
CREATE INDEX "Department_clientId_deletedAt_idx" ON "Department" ("clientId", "deletedAt");
CREATE INDEX "Department_parentId_idx" ON "Department" ("parentId");
CREATE UNIQUE INDEX "Department_clientId_code_key" ON "Department" ("clientId", "code")
  WHERE "code" IS NOT NULL AND "deletedAt" IS NULL;

-- 3. CostCenter — finance dimension on every transaction.
CREATE TABLE "CostCenter" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID NOT NULL,
  "code"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "CostCenter_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "CostCenter_clientId_code_key" ON "CostCenter" ("clientId", "code")
  WHERE "deletedAt" IS NULL;
CREATE INDEX "CostCenter_clientId_deletedAt_idx" ON "CostCenter" ("clientId", "deletedAt");

-- 4. JobProfile — title taxonomy with family + level + FLSA exemption.
CREATE TABLE "JobProfile" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID NOT NULL,
  "code"        TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "family"      TEXT,
  "level"       TEXT,
  "isExempt"    BOOLEAN NOT NULL DEFAULT FALSE,
  "description" TEXT,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "JobProfile_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "JobProfile_clientId_code_key" ON "JobProfile" ("clientId", "code")
  WHERE "deletedAt" IS NULL;
CREATE INDEX "JobProfile_clientId_family_idx" ON "JobProfile" ("clientId", "family");
CREATE INDEX "JobProfile_clientId_deletedAt_idx" ON "JobProfile" ("clientId", "deletedAt");

-- 5. Associate gets the four optional FKs. All nullable; nothing in
--    existing routes depends on them, so backfill is opportunistic.
ALTER TABLE "Associate"
  ADD COLUMN "managerId"     UUID,
  ADD COLUMN "departmentId"  UUID,
  ADD COLUMN "costCenterId"  UUID,
  ADD COLUMN "jobProfileId"  UUID;

ALTER TABLE "Associate"
  ADD CONSTRAINT "Associate_managerId_fkey"
    FOREIGN KEY ("managerId") REFERENCES "Associate"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Associate_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Associate_costCenterId_fkey"
    FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Associate_jobProfileId_fkey"
    FOREIGN KEY ("jobProfileId") REFERENCES "JobProfile"("id") ON DELETE SET NULL;

CREATE INDEX "Associate_managerId_idx"    ON "Associate" ("managerId");
CREATE INDEX "Associate_departmentId_idx" ON "Associate" ("departmentId");
CREATE INDEX "Associate_costCenterId_idx" ON "Associate" ("costCenterId");
CREATE INDEX "Associate_jobProfileId_idx" ON "Associate" ("jobProfileId");
