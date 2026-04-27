-- Phase 89 — Mail-merge document templates with version history.
--
-- Templates store handlebars-style markup with tokens like
-- {{ associate.firstName }}. Each save creates a DocumentTemplateVersion
-- snapshot so generated docs can pin to the exact version they used.
-- Generation produces a DocumentRender with the rendered text + JSON of
-- the data passed in.

CREATE TYPE "DocumentTemplateKind" AS ENUM (
  'OFFER_LETTER',
  'POLICY',
  'NDA',
  'PROMOTION_LETTER',
  'TERMINATION_LETTER',
  'WARNING_LETTER',
  'GENERIC'
);

CREATE TABLE "DocumentTemplate" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"     UUID,
  "name"         TEXT NOT NULL,
  "kind"         "DocumentTemplateKind" NOT NULL DEFAULT 'GENERIC',
  -- Pointer to the current published version (null while only DRAFT exists).
  "currentVersionId" UUID,
  "createdById"  UUID,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"    TIMESTAMPTZ(6),
  CONSTRAINT "DocumentTemplate_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "DocumentTemplate_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "DocumentTemplate_clientId_idx" ON "DocumentTemplate" ("clientId");
CREATE INDEX "DocumentTemplate_kind_idx" ON "DocumentTemplate" ("kind");

CREATE TABLE "DocumentTemplateVersion" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "templateId"   UUID NOT NULL,
  -- Monotonic per template. version=1 on first save, +1 on each publish.
  "version"      INTEGER NOT NULL,
  "subject"      TEXT,
  "body"         TEXT NOT NULL,
  -- Snapshot of variable schema (which tokens this version expects).
  "variables"    JSONB,
  "publishedAt"  TIMESTAMPTZ(6),
  "publishedById" UUID,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "DocumentTemplateVersion_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "DocumentTemplate"("id") ON DELETE CASCADE,
  CONSTRAINT "DocumentTemplateVersion_publishedById_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "DocumentTemplateVersion_unique" UNIQUE ("templateId", "version")
);
CREATE INDEX "DocumentTemplateVersion_templateId_version_idx"
  ON "DocumentTemplateVersion" ("templateId", "version" DESC);

-- Now add the FK from DocumentTemplate.currentVersionId.
ALTER TABLE "DocumentTemplate"
  ADD CONSTRAINT "DocumentTemplate_currentVersionId_fkey"
  FOREIGN KEY ("currentVersionId")
  REFERENCES "DocumentTemplateVersion"("id") ON DELETE SET NULL;

CREATE TABLE "DocumentRender" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "templateId"   UUID NOT NULL,
  "versionId"    UUID NOT NULL,
  -- Optional associate this render targets. Lets HR find "all letters
  -- generated for X" without re-parsing every render.
  "associateId"  UUID,
  "renderedSubject" TEXT,
  "renderedBody" TEXT NOT NULL,
  -- The exact JSON used to render — preserved so we can reproduce
  -- byte-for-byte even if Associate fields drift later.
  "data"         JSONB NOT NULL,
  "renderedById" UUID,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "DocumentRender_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "DocumentTemplate"("id") ON DELETE CASCADE,
  CONSTRAINT "DocumentRender_versionId_fkey"
    FOREIGN KEY ("versionId") REFERENCES "DocumentTemplateVersion"("id") ON DELETE RESTRICT,
  CONSTRAINT "DocumentRender_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE SET NULL,
  CONSTRAINT "DocumentRender_renderedById_fkey"
    FOREIGN KEY ("renderedById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "DocumentRender_templateId_idx" ON "DocumentRender" ("templateId");
CREATE INDEX "DocumentRender_associateId_idx" ON "DocumentRender" ("associateId");
