-- Email deliverability loop: Resend event webhook, suppression list,
-- provider message id on Notification.
--
-- NOTE: ALTER TYPE ... ADD VALUE runs inside the migration transaction —
-- allowed on PostgreSQL 12+ as long as the new values are not used by a
-- statement in the same transaction (they aren't; only DDL below).

-- New delivery statuses driven by async Resend events / the suppression list.
ALTER TYPE "NotificationStatus" ADD VALUE 'BOUNCED';
ALTER TYPE "NotificationStatus" ADD VALUE 'COMPLAINED';
ALTER TYPE "NotificationStatus" ADD VALUE 'SUPPRESSED';

-- Resend's message id for real EMAIL sends, so async webhook events can be
-- matched back to the Notification row.
ALTER TABLE "Notification" ADD COLUMN "providerMessageId" TEXT;

CREATE INDEX "Notification_providerMessageId_idx" ON "Notification"("providerMessageId");
-- Fallback matcher: pre-existing rows only carry the Resend id in externalRef.
CREATE INDEX "Notification_externalRef_idx" ON "Notification"("externalRef");

-- Inbound Resend webhook event log + idempotency (mirrors BranchWebhookEvent).
CREATE TYPE "ResendWebhookStatus" AS ENUM ('PROCESSED', 'IGNORED', 'ERROR');

CREATE TABLE "ResendWebhookEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "svixId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ResendWebhookStatus" NOT NULL DEFAULT 'PROCESSED',
    "notificationId" UUID,
    "notes" TEXT,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ResendWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResendWebhookEvent_svixId_key" ON "ResendWebhookEvent"("svixId");
CREATE INDEX "ResendWebhookEvent_eventType_receivedAt_idx" ON "ResendWebhookEvent"("eventType", "receivedAt");
CREATE INDEX "ResendWebhookEvent_status_receivedAt_idx" ON "ResendWebhookEvent"("status", "receivedAt");

-- Do-not-email list.
CREATE TYPE "EmailSuppressionReason" AS ENUM ('BOUNCED', 'COMPLAINED', 'MANUAL');

CREATE TABLE "EmailSuppression" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");
