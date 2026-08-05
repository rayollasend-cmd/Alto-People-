-- Outbound webhook delivery worker (Phase 93 follow-up) — additive only.
-- The async worker the Phase 93 header promised now exists; it needs a
-- RETRYING state between attempts and a nextAttemptAt due-time so
-- exponential backoff survives restarts. Existing rows are untouched:
-- nextAttemptAt stays NULL, which the worker treats as "due now".

ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'RETRYING';

ALTER TABLE "WebhookDelivery" ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(6);

-- Claim query: WHERE status IN ('PENDING','RETRYING') AND nextAttemptAt <= now.
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx"
  ON "WebhookDelivery"("status", "nextAttemptAt");
