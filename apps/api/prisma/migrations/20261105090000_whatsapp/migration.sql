-- Brief 1C-4: WhatsApp as a delivery channel. Additive: two enum values,
-- two tables. The new enum values are not used by this migration itself
-- (Postgres forbids that inside the transaction that adds them).

ALTER TYPE "NotificationChannel" ADD VALUE 'WHATSAPP';
ALTER TYPE "NotificationStatus" ADD VALUE 'DELIVERED';

CREATE TYPE "WhatsAppConsentStatus" AS ENUM ('OPTED_IN', 'OPTED_OUT');
CREATE TYPE "WhatsAppDirection" AS ENUM ('OUTBOUND', 'INBOUND');
CREATE TYPE "WhatsAppMessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');
CREATE TYPE "WhatsAppMessageKind" AS ENUM ('TEMPLATE', 'TEXT', 'QUESTION', 'ANSWER', 'HANDOFF', 'SYSTEM');

CREATE TABLE "WhatsAppConsent" (
    "associateId" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "status" "WhatsAppConsentStatus" NOT NULL DEFAULT 'OPTED_IN',
    "source" VARCHAR(20) NOT NULL DEFAULT 'app',
    "optedInAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "optedOutAt" TIMESTAMPTZ(6),
    "lastInboundAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WhatsAppConsent_pkey" PRIMARY KEY ("associateId")
);

CREATE INDEX "WhatsAppConsent_phone_idx" ON "WhatsAppConsent"("phone");

ALTER TABLE "WhatsAppConsent" ADD CONSTRAINT "WhatsAppConsent_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WhatsAppMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID,
    "phone" VARCHAR(20) NOT NULL,
    "direction" "WhatsAppDirection" NOT NULL,
    "kind" "WhatsAppMessageKind" NOT NULL,
    "waMessageId" VARCHAR(120),
    "templateName" VARCHAR(80),
    "language" VARCHAR(2) NOT NULL DEFAULT 'en',
    "body" VARCHAR(4000) NOT NULL,
    "category" VARCHAR(80),
    "status" "WhatsAppMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "statusAt" TIMESTAMPTZ(6),
    "failureReason" VARCHAR(500),
    "notificationId" UUID,
    "conversationId" UUID,
    "replyToId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppMessage_waMessageId_key" ON "WhatsAppMessage"("waMessageId");
CREATE INDEX "WhatsAppMessage_associateId_createdAt_idx" ON "WhatsAppMessage"("associateId", "createdAt" DESC);
CREATE INDEX "WhatsAppMessage_phone_createdAt_idx" ON "WhatsAppMessage"("phone", "createdAt" DESC);
CREATE INDEX "WhatsAppMessage_status_createdAt_idx" ON "WhatsAppMessage"("status", "createdAt");

ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
