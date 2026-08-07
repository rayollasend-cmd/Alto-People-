-- SCIM 2.0 user provisioning (Entra ID / Okta): store the IdP's own
-- identifier (externalId) so it can be echoed back on every SCIM read.
-- Additive only — one nullable column, zero existing rows touched.
ALTER TABLE "User" ADD COLUMN "scimExternalId" VARCHAR(255);
