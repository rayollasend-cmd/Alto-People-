-- Phase 95 — Worktags: Workday-style multi-dimensional tagging on
-- transactions (time entries, payroll items, expenses). A worktag has
-- a category (e.g. "Department", "Project", "GL Account", "Region")
-- and a value; transactions reference worktags via a polymorphic join.

CREATE TYPE "WorktagEntityKind" AS ENUM (
  'TIME_ENTRY',
  'PAYROLL_ITEM',
  'EXPENSE',
  'PURCHASE_ORDER'
);

CREATE TABLE "WorktagCategory" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"         VARCHAR(80) NOT NULL UNIQUE, -- machine name, e.g. 'gl_account'
  "label"       TEXT NOT NULL,
  "description" TEXT,
  "isRequired"  BOOLEAN NOT NULL DEFAULT FALSE,
  "isActive"    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL
);

CREATE TABLE "Worktag" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "categoryId" UUID NOT NULL,
  "value"      TEXT NOT NULL,
  "code"       VARCHAR(80), -- e.g. 'GL-4501' or 'PRJ-NORTH'
  "isActive"   BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Worktag_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "WorktagCategory"("id") ON DELETE CASCADE
);
CREATE INDEX "Worktag_categoryId_active_idx"
  ON "Worktag" ("categoryId", "isActive");
-- Within a category, values must be unique.
CREATE UNIQUE INDEX "Worktag_categoryId_value_unique"
  ON "Worktag" ("categoryId", "value");

-- Polymorphic join. A single transaction can carry multiple worktags
-- spanning different categories (one Project + one GL + one Region).
CREATE TABLE "WorktagAssignment" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "worktagId"  UUID NOT NULL,
  "entityKind" "WorktagEntityKind" NOT NULL,
  "entityId"   UUID NOT NULL,
  "createdById" UUID,
  "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "WorktagAssignment_worktagId_fkey"
    FOREIGN KEY ("worktagId") REFERENCES "Worktag"("id") ON DELETE CASCADE,
  CONSTRAINT "WorktagAssignment_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "WorktagAssignment_entity_idx"
  ON "WorktagAssignment" ("entityKind", "entityId");
CREATE INDEX "WorktagAssignment_worktagId_idx"
  ON "WorktagAssignment" ("worktagId");
-- A given entity can carry only one worktag per category — enforced
-- in application code (we'd need a CTE for the DB-level check).
