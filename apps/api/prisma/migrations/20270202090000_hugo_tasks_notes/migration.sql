-- Hugo works for you (lib/hugoTasks, lib/hugoNotes; packages/shared/src/hugoWork.ts).
--
-- HugoTask: work a person handed the assistant with a tap — watch for a
-- decision, a paycheck or an open shift; ask coworkers to cover a shift one
-- at a time; chase tomorrow's unconfirmed shifts. HugoTaskEvent is its
-- trail. HugoNote: something the assistant noticed in a person's own
-- records, one per person, kind and subject. HugoNoteMute: a kind of note
-- the person turned off. Tenant-keyed and under the wall
-- (20270128190100_tenancy_rls).

CREATE TABLE "HugoTask" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'WORKING',
  "needs" VARCHAR(32),
  "params" JSONB NOT NULL DEFAULT '{}',
  "subject" JSONB NOT NULL DEFAULT '{}',
  "state" JSONB NOT NULL DEFAULT '{}',
  "progress" JSONB,
  "result" JSONB,
  "linkUrl" VARCHAR(300),
  "source" VARCHAR(8) NOT NULL DEFAULT 'panel',
  "noteId" UUID,
  "nextCheckAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMPTZ(6),
  "seenAt" TIMESTAMPTZ(6),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "HugoTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HugoTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "HugoTask_userId_status_idx" ON "HugoTask"("userId", "status");
CREATE INDEX "HugoTask_status_nextCheckAt_idx" ON "HugoTask"("status", "nextCheckAt");
CREATE INDEX "HugoTask_tenantId_idx" ON "HugoTask"("tenantId");

CREATE TABLE "HugoTaskEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "taskId" UUID NOT NULL,
  "code" VARCHAR(32) NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HugoTaskEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HugoTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "HugoTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "HugoTaskEvent_taskId_createdAt_idx" ON "HugoTaskEvent"("taskId", "createdAt");
CREATE INDEX "HugoTaskEvent_tenantId_idx" ON "HugoTaskEvent"("tenantId");

CREATE TABLE "HugoNote" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "subjectKey" VARCHAR(120) NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "status" VARCHAR(12) NOT NULL DEFAULT 'NEW',
  "pushedAt" TIMESTAMPTZ(6),
  "seenAt" TIMESTAMPTZ(6),
  "actedAt" TIMESTAMPTZ(6),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "HugoNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HugoNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HugoNote_userId_kind_subjectKey_key" ON "HugoNote"("userId", "kind", "subjectKey");
CREATE INDEX "HugoNote_userId_status_idx" ON "HugoNote"("userId", "status");
CREATE INDEX "HugoNote_tenantId_idx" ON "HugoNote"("tenantId");

CREATE TABLE "HugoNoteMute" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HugoNoteMute_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HugoNoteMute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HugoNoteMute_userId_kind_key" ON "HugoNoteMute"("userId", "kind");
CREATE INDEX "HugoNoteMute_tenantId_idx" ON "HugoNoteMute"("tenantId");

-- Under the wall (20270128190100_tenancy_rls).
SELECT alto_tenant_rls_policies('HugoTask');
ALTER TABLE "HugoTask" ENABLE ROW LEVEL SECURITY;
SELECT alto_tenant_rls_policies('HugoTaskEvent');
ALTER TABLE "HugoTaskEvent" ENABLE ROW LEVEL SECURITY;
SELECT alto_tenant_rls_policies('HugoNote');
ALTER TABLE "HugoNote" ENABLE ROW LEVEL SECURITY;
SELECT alto_tenant_rls_policies('HugoNoteMute');
ALTER TABLE "HugoNoteMute" ENABLE ROW LEVEL SECURITY;
