-- A quarter's executive targets belong to one tenant. The key was unique
-- across the platform, so one tenant setting its targets could overwrite
-- (or be blocked by) another's.
DROP INDEX IF EXISTS "ExecTarget_quarter_key";
CREATE UNIQUE INDEX "ExecTarget_tenantId_quarter_key" ON "ExecTarget"("tenantId", "quarter");
