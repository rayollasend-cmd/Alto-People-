-- What Hugo knows (Muse phase 4; lib/hugoMemory, packages/shared/src/hugoMemory.ts).
--
-- HugoMemory: a short fact a person told the assistant about themselves (or
-- typed in "What Hugo knows"), theirs to read, change and remove; at most 50
-- per person, 200 characters each, never anything sensitive (the guard runs
-- before every insert). HugoMemorySetting: the person's memory switch — no
-- row means on. Both new and empty: nothing existing changes. Tenant-keyed
-- and under the wall (20270128190100_tenancy_rls); a person's rows go with
-- their account (ON DELETE CASCADE) and with erasure (lib/erasure).

CREATE TABLE "HugoMemory" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "kind" VARCHAR(16) NOT NULL DEFAULT 'OTHER',
  "text" VARCHAR(200) NOT NULL,
  "source" VARCHAR(8) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "lastUsedAt" TIMESTAMPTZ(6),
  CONSTRAINT "HugoMemory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HugoMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "HugoMemory_userId_createdAt_idx" ON "HugoMemory"("userId", "createdAt");
CREATE INDEX "HugoMemory_tenantId_idx" ON "HugoMemory"("tenantId");

CREATE TABLE "HugoMemorySetting" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "memoryOn" BOOLEAN NOT NULL DEFAULT true,
  "introducedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "HugoMemorySetting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HugoMemorySetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HugoMemorySetting_userId_key" ON "HugoMemorySetting"("userId");
CREATE INDEX "HugoMemorySetting_tenantId_idx" ON "HugoMemorySetting"("tenantId");

-- Under the wall (20270128190100_tenancy_rls).
SELECT alto_tenant_rls_policies('HugoMemory');
ALTER TABLE "HugoMemory" ENABLE ROW LEVEL SECURITY;
SELECT alto_tenant_rls_policies('HugoMemorySetting');
ALTER TABLE "HugoMemorySetting" ENABLE ROW LEVEL SECURITY;
