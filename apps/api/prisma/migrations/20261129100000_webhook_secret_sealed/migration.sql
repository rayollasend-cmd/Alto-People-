-- Brief 2-4 step 5 — webhook signing secrets sealed at rest with their own key.
-- Additive: one nullable column; the app seals existing rows on its first
-- delivery tick (the key lives in the app, not the database).

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "secretEnc" BYTEA;

