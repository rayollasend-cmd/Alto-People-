-- Each person's own Hugo and what his thinking costs (lib/hugoAllowance).
--
-- HugoProfile: one row per account (made on first use), holding the 30-day
-- allowance cycle for associates, drivers and floor/shift supervisors.
-- HugoUsage: one row per model call, charged to the person it was for —
-- tokens and cost in millionths of a dollar, never the words. Both are new
-- tables (nothing existing changes), tenant-keyed and under the wall.

CREATE TABLE IF NOT EXISTS "HugoProfile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "allowanceCycleStartedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "HugoProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HugoProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "HugoProfile_tenantId_userId_key" ON "HugoProfile"("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "HugoProfile_tenantId_idx" ON "HugoProfile"("tenantId");

CREATE TABLE IF NOT EXISTS "HugoUsage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "purpose" VARCHAR(12) NOT NULL,
  "tier" VARCHAR(8) NOT NULL,
  "model" VARCHAR(40) NOT NULL,
  "inputTokens" INTEGER NOT NULL,
  "cachedTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL,
  "costMicros" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HugoUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HugoUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "HugoUsage_userId_createdAt_idx" ON "HugoUsage"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "HugoUsage_tenantId_idx" ON "HugoUsage"("tenantId");

SELECT alto_tenant_rls_policies('HugoProfile');
ALTER TABLE "HugoProfile" ENABLE ROW LEVEL SECURITY;
SELECT alto_tenant_rls_policies('HugoUsage');
ALTER TABLE "HugoUsage" ENABLE ROW LEVEL SECURITY;
