-- When the automatic recruiting clean-up first ran on this server. Nothing
-- closes until a grace period after it, so records already past their limit
-- that day show as "closing soon" first instead of closing without warning.
ALTER TABLE "OrgSetting" ADD COLUMN IF NOT EXISTS "recruitingCleanupSince" TIMESTAMPTZ(6);
