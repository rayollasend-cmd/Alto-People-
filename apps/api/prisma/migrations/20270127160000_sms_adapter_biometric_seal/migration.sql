-- Outbound SMS (Twilio) with an honest NOT_CONFIGURED status, STOP opt-outs,
-- broadcast delivery counts per channel, and the SOC 2 seal on kiosk selfies
-- and face templates (backfilled in batches by the biometric-encryption job).

ALTER TYPE "NotificationStatus" ADD VALUE IF NOT EXISTS 'NOT_CONFIGURED';

CREATE TABLE "SmsOptOut" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" TEXT NOT NULL,
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "reason" VARCHAR(40) NOT NULL,
    "source" VARCHAR(80),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsOptOut_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmsOptOut_phone_key" ON "SmsOptOut"("phone");
CREATE INDEX "SmsOptOut_tenantId_idx" ON "SmsOptOut"("tenantId");

ALTER TABLE "Broadcast" ADD COLUMN "delivery" JSONB;

ALTER TABLE "KioskPunch" ADD COLUMN "selfieEncrypted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "KioskFaceReference" ADD COLUMN "descriptorEncrypted" BOOLEAN NOT NULL DEFAULT false;
