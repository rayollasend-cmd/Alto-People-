-- AI disclosure by default: the in-app record of a message an agent caused
-- names the agent (its Worker id) so the bell and the thread can badge it
-- "AI". Null for people and the system. No foreign key: the record outlives
-- the agent's registry row, as the audit trail does.
ALTER TABLE "Notification" ADD COLUMN "byAgentId" UUID;
ALTER TABLE "Message" ADD COLUMN "byAgentId" UUID;

-- The assistant's name (and the rest of OrgSetting) is each tenant's own:
-- one row per tenant, read and written by tenantId. Alto HR keeps the
-- historical id 'singleton'; another tenant's row takes an id derived from
-- its tenant id (lib/branding.ts orgSettingIdFor). Should a tenant somehow
-- hold two rows, the singleton wins, else the most recently updated.
DELETE FROM "OrgSetting" a
USING "OrgSetting" b
WHERE a."tenantId" = b."tenantId"
  AND a.id <> b.id
  AND (
    b.id = 'singleton'
    OR (a.id <> 'singleton' AND a."updatedAt" < b."updatedAt")
    OR (a.id <> 'singleton' AND a."updatedAt" = b."updatedAt" AND a.id > b.id)
  );
DROP INDEX IF EXISTS "OrgSetting_tenantId_idx";
CREATE UNIQUE INDEX "OrgSetting_tenantId_key" ON "OrgSetting"("tenantId");
-- The table was born a singleton (20260502030000_org_settings); the check that
-- pinned every row to id 'singleton' goes, the unique tenantId takes its place.
ALTER TABLE "OrgSetting" DROP CONSTRAINT IF EXISTS "OrgSetting_singleton_chk";
