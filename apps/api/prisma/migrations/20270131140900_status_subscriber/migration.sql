-- F500 G5: incident updates by email from the public status page.
--
-- One row per address that asked; updates go only to confirmed ones (double
-- opt-in) and each carries an unsubscribe link. The confirm and unsubscribe
-- links are HMAC-signed over the row id (lib/statusSubscribers), so the table
-- holds no secret. Tenant-keyed (the platform operator's) and under the wall.

CREATE TABLE "StatusSubscriber" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "email" VARCHAR(254) NOT NULL,
  "confirmedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StatusSubscriber_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StatusSubscriber_tenantId_email_key" ON "StatusSubscriber"("tenantId", "email");
CREATE INDEX "StatusSubscriber_tenantId_idx" ON "StatusSubscriber"("tenantId");

-- Under the wall (20270128190100_tenancy_rls).
SELECT alto_tenant_rls_policies('StatusSubscriber');
ALTER TABLE "StatusSubscriber" ENABLE ROW LEVEL SECURITY;
