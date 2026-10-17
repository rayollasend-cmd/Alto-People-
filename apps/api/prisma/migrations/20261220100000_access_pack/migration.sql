-- Access pack: per-site/region scope for internal roles, break-glass
-- owners, a tenant security policy (CIDR allowlists, session timeouts,
-- device trust), trusted devices, access certification campaigns, and
-- quiet hours / digest delivery for notifications.

CREATE TYPE "DeliveryMode" AS ENUM ('REALTIME', 'DIGEST');
CREATE TYPE "AccessCertificationScope" AS ENUM ('ALL', 'INTERNAL', 'CLIENT', 'ASSOCIATE');
CREATE TYPE "AccessCertificationStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "AccessCertificationDecision" AS ENUM ('KEEP', 'REVOKE', 'CHANGE');

ALTER TABLE "User"
  ADD COLUMN "scopeSiteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "scopeRegionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "scopeApprovedById" UUID,
  ADD COLUMN "scopeApprovedAt" TIMESTAMPTZ(6),
  ADD COLUMN "breakGlass" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "breakGlassApprovedById" UUID,
  ADD COLUMN "breakGlassApprovedAt" TIMESTAMPTZ(6),
  ADD COLUMN "quietHoursStart" INTEGER,
  ADD COLUMN "quietHoursEnd" INTEGER,
  ADD COLUMN "deliveryEmail" "DeliveryMode" NOT NULL DEFAULT 'REALTIME',
  ADD COLUMN "deliveryPush" "DeliveryMode" NOT NULL DEFAULT 'REALTIME',
  ADD COLUMN "deliverySms" "DeliveryMode" NOT NULL DEFAULT 'REALTIME';

CREATE TABLE "TenantSecurityPolicy" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "sessionIdleMinutes" INTEGER,
  "sessionAbsoluteHours" INTEGER,
  "allowedCidrsInternal" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "allowedCidrsClient" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "allowedCidrsAssociate" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "deviceTrustEnabled" BOOLEAN NOT NULL DEFAULT false,
  "deviceTrustDays" INTEGER NOT NULL DEFAULT 30,
  "breakGlassEnabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedById" UUID,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantSecurityPolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantSecurityPolicy_tenantId_key" ON "TenantSecurityPolicy"("tenantId");

CREATE TABLE "TrustedDevice" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "label" VARCHAR(200) NOT NULL,
  "ip" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TrustedDevice_tokenHash_key" ON "TrustedDevice"("tokenHash");
CREATE INDEX "TrustedDevice_userId_revokedAt_idx" ON "TrustedDevice"("userId", "revokedAt");
CREATE INDEX "TrustedDevice_tenantId_idx" ON "TrustedDevice"("tenantId");

CREATE TABLE "AccessCertification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "name" VARCHAR(160) NOT NULL,
  "scope" "AccessCertificationScope" NOT NULL DEFAULT 'ALL',
  "status" "AccessCertificationStatus" NOT NULL DEFAULT 'OPEN',
  "dueAt" TIMESTAMPTZ(6) NOT NULL,
  "createdById" UUID NOT NULL,
  "closedById" UUID,
  "closedAt" TIMESTAMPTZ(6),
  "lastReminderAt" TIMESTAMPTZ(6),
  "evidenceId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AccessCertification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccessCertification_tenantId_status_idx" ON "AccessCertification"("tenantId", "status");

CREATE TABLE "AccessCertificationItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "certificationId" UUID NOT NULL,
  "subjectUserId" UUID NOT NULL,
  "snapshot" JSONB NOT NULL DEFAULT '{}',
  "reviewerUserId" UUID NOT NULL,
  "decision" "AccessCertificationDecision",
  "note" VARCHAR(500),
  "decidedById" UUID,
  "decidedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccessCertificationItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccessCertificationItem_certificationId_fkey" FOREIGN KEY ("certificationId") REFERENCES "AccessCertification"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AccessCertificationItem_certificationId_subjectUserId_key" ON "AccessCertificationItem"("certificationId", "subjectUserId");
CREATE INDEX "AccessCertificationItem_reviewerUserId_decision_idx" ON "AccessCertificationItem"("reviewerUserId", "decision");
CREATE INDEX "AccessCertificationItem_tenantId_idx" ON "AccessCertificationItem"("tenantId");

CREATE TABLE "DeferredNotification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId" UUID NOT NULL,
  "channel" VARCHAR(16) NOT NULL,
  "reason" VARCHAR(16) NOT NULL,
  "subject" VARCHAR(300),
  "body" TEXT NOT NULL,
  "linkUrl" VARCHAR(500),
  "category" VARCHAR(64),
  "dueAt" TIMESTAMPTZ(6) NOT NULL,
  "sentAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeferredNotification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeferredNotification_sentAt_dueAt_idx" ON "DeferredNotification"("sentAt", "dueAt");
CREATE INDEX "DeferredNotification_userId_idx" ON "DeferredNotification"("userId");
CREATE INDEX "DeferredNotification_tenantId_idx" ON "DeferredNotification"("tenantId");
