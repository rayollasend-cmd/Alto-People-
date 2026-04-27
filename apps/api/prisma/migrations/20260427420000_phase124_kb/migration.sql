-- Phase 124 — Knowledge base / FAQ. Self-service articles to deflect HR
-- cases. Per-client OR company-wide (clientId NULL). slug must be unique
-- inside its scope (uses COALESCE so NULL clientIds participate).
CREATE TYPE "KbStatus" AS ENUM (
  'DRAFT',
  'PUBLISHED',
  'ARCHIVED'
);

CREATE TABLE "KbArticle" (
  "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
  "clientId"    UUID,
  "title"       TEXT            NOT NULL,
  "slug"        TEXT            NOT NULL,
  "body"        TEXT            NOT NULL,
  "category"    TEXT            NOT NULL,
  "tags"        TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"      "KbStatus"      NOT NULL DEFAULT 'DRAFT',
  "views"       INTEGER         NOT NULL DEFAULT 0,
  "helpful"     INTEGER         NOT NULL DEFAULT 0,
  "notHelpful"  INTEGER         NOT NULL DEFAULT 0,
  "publishedAt" TIMESTAMPTZ(6),
  "authorId"    UUID,
  "createdAt"   TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "KbArticle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KbArticle_client_slug_key"
  ON "KbArticle"(COALESCE("clientId", '00000000-0000-0000-0000-000000000000'::uuid), "slug");
CREATE INDEX "KbArticle_status_idx" ON "KbArticle"("status");
CREATE INDEX "KbArticle_category_idx" ON "KbArticle"("category");

ALTER TABLE "KbArticle" ADD CONSTRAINT "KbArticle_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KbArticle" ADD CONSTRAINT "KbArticle_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "KbFeedback" (
  "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
  "articleId"   UUID            NOT NULL,
  "associateId" UUID            NOT NULL,
  "helpful"     BOOLEAN         NOT NULL,
  "comment"     TEXT,
  "createdAt"   TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "KbFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KbFeedback_article_associate_key"
  ON "KbFeedback"("articleId", "associateId");
CREATE INDEX "KbFeedback_articleId_idx" ON "KbFeedback"("articleId");

ALTER TABLE "KbFeedback" ADD CONSTRAINT "KbFeedback_articleId_fkey"
  FOREIGN KEY ("articleId") REFERENCES "KbArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KbFeedback" ADD CONSTRAINT "KbFeedback_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
