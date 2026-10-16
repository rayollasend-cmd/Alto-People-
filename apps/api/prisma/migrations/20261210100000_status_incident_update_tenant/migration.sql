-- Brief 2-1: the status incident timeline carries the tenant like every other table
-- (the status page's own migration left it off; the schema test catches that).
ALTER TABLE "StatusIncidentUpdate" ADD COLUMN "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001';
