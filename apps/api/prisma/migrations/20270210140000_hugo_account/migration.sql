-- One Hugo per account, everywhere the person signs in (owner, 2026-10-29) — lib/hugoThread.
--
-- 1. HugoProfile gains the person's Hugo settings that lived in one browser:
--    "readAloud" (NULL = never chosen; the app carries a browser's earlier
--    choice up once, so nobody's setting silently changes) and
--    "threadClearedAt" (the last "Start over", for every device). Two
--    nullable columns: no rewrite, nothing existing changes.
-- 2. HugoTurn: the conversation in the app, kept on the server so it follows
--    the account, not the browser tab. Redacted words only (never an SSN or
--    an account number), the intent and the link; removed after 90 days by
--    the hugoThread sweep. A new table, tenant-keyed, under the wall, and it
--    goes with the account (ON DELETE CASCADE).
-- 3. Backfill (rows ADDED, none changed): a HugoProfile for every account
--    Hugo can serve that has none yet — every login except a client-portal
--    one, not deleted. New accounts get theirs on their first GET /hugo
--    (lib/hugoThread ensureHugoProfile), whichever way they were created.

ALTER TABLE "HugoProfile" ADD COLUMN IF NOT EXISTS "readAloud" BOOLEAN;
ALTER TABLE "HugoProfile" ADD COLUMN IF NOT EXISTS "threadClearedAt" TIMESTAMPTZ(6);

CREATE TABLE IF NOT EXISTS "HugoTurn" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "role" VARCHAR(10) NOT NULL,
  "text" VARCHAR(4000) NOT NULL,
  "intent" VARCHAR(40),
  "linkUrl" VARCHAR(300),
  "channel" VARCHAR(12) NOT NULL DEFAULT 'app',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HugoTurn_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HugoTurn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "HugoTurn_userId_createdAt_idx" ON "HugoTurn"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "HugoTurn_tenantId_idx" ON "HugoTurn"("tenantId");
CREATE INDEX IF NOT EXISTS "HugoTurn_tenantId_createdAt_idx" ON "HugoTurn"("tenantId", "createdAt");

SELECT alto_tenant_rls_policies('HugoTurn');
ALTER TABLE "HugoTurn" ENABLE ROW LEVEL SECURITY;

INSERT INTO "HugoProfile" ("tenantId", "userId", "updatedAt")
SELECT u."tenantId", u."id", CURRENT_TIMESTAMP
FROM "User" u
WHERE u."role" <> 'CLIENT_PORTAL' AND u."deletedAt" IS NULL
ON CONFLICT ("tenantId", "userId") DO NOTHING;
