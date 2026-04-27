-- Phase 81 — Custom fields.
--
-- HR can declare per-client custom fields on Associate (and other
-- entities later) without schema changes. Definition row carries the
-- type + options + required flag; values are stored in a sibling
-- CustomFieldValue table keyed by (definitionId, entityType, entityId).
--
-- Type system: TEXT / NUMBER / DATE / BOOLEAN / SELECT / MULTISELECT.
-- Options are stored on the definition for SELECT / MULTISELECT.

CREATE TYPE "CustomFieldType" AS ENUM (
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
  'MULTISELECT'
);

CREATE TYPE "CustomFieldEntity" AS ENUM (
  'ASSOCIATE',
  'POSITION',
  'CLIENT'
);

CREATE TABLE "CustomFieldDefinition" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID,    -- NULL = global (applies across clients)
  "entityType"  "CustomFieldEntity" NOT NULL,
  -- Stable machine key. URL-safe, unique per (clientId, entityType).
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "type"        "CustomFieldType" NOT NULL,
  "isRequired"  BOOLEAN NOT NULL DEFAULT FALSE,
  "isSensitive" BOOLEAN NOT NULL DEFAULT FALSE,  -- hidden from non-HR
  "helpText"    TEXT,
  "options"     JSONB,  -- ["A", "B", "C"] for SELECT / MULTISELECT
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "CustomFieldDefinition_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE
);
-- Unique key per (clientId, entityType). NULL clientId is treated as a
-- distinct group, so the global "department_pref" can co-exist with a
-- client-specific "department_pref".
CREATE UNIQUE INDEX "CustomFieldDefinition_global_key_unique"
  ON "CustomFieldDefinition" ("entityType", "key")
  WHERE "clientId" IS NULL AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "CustomFieldDefinition_scoped_key_unique"
  ON "CustomFieldDefinition" ("clientId", "entityType", "key")
  WHERE "clientId" IS NOT NULL AND "deletedAt" IS NULL;
CREATE INDEX "CustomFieldDefinition_entityType_idx"
  ON "CustomFieldDefinition" ("entityType")
  WHERE "deletedAt" IS NULL;

-- One row per (definition, entity record). The entity FK is implicit
-- (we trust callers to use valid UUIDs), since we'd otherwise need a
-- polymorphic FK across three tables.
CREATE TABLE "CustomFieldValue" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "definitionId" UUID NOT NULL,
  "entityType"   "CustomFieldEntity" NOT NULL,
  "entityId"     UUID NOT NULL,
  -- Universal value column — encoded according to definition.type:
  --   TEXT/SELECT  → { "v": "string" }
  --   NUMBER       → { "v": 42.5 }
  --   DATE         → { "v": "2026-04-27" }
  --   BOOLEAN      → { "v": true }
  --   MULTISELECT  → { "v": ["A", "B"] }
  "value"        JSONB NOT NULL,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "CustomFieldValue_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "CustomFieldDefinition"("id") ON DELETE CASCADE,
  CONSTRAINT "CustomFieldValue_unique"
    UNIQUE ("definitionId", "entityId")
);
CREATE INDEX "CustomFieldValue_entityType_entityId_idx"
  ON "CustomFieldValue" ("entityType", "entityId");
