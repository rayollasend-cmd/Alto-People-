-- Brief 2-1b, step 7 (first half): a site has a type. The table keeps its
-- name until the rename comes last (the owner's decision 1); every site on
-- file is a store today.
DO $$ BEGIN
  CREATE TYPE "SiteType" AS ENUM ('STORE', 'PROPERTY', 'OFFICE', 'WAREHOUSE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "type" "SiteType" NOT NULL DEFAULT 'STORE';
