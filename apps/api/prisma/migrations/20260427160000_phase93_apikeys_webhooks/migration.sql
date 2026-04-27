-- Phase 93 — Public API keys + outbound webhooks.
-- Customers (or partner integrations) can mint API keys to call the
-- platform programmatically, and subscribe webhook endpoints to receive
-- domain events. Keys are stored as bcrypt hashes (never the plaintext);
-- the plaintext is shown to the user exactly once at creation.

CREATE TYPE "WebhookDeliveryStatus" AS ENUM (
  'PENDING',
  'DELIVERED',
  'FAILED'
);

CREATE TABLE "ApiKey" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID,
  "name"        TEXT NOT NULL,
  -- Last 4 of the plaintext, for display. Helps the customer identify
  -- which key is which without leaking the secret.
  "last4"       VARCHAR(4) NOT NULL,
  "keyHash"     TEXT NOT NULL,
  -- Capabilities granted to this key (subset of the role capabilities).
  -- E.g. ['view:clients', 'view:onboarding']. Empty = inherit creator's.
  "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdById" UUID NOT NULL,
  "lastUsedAt"  TIMESTAMPTZ(6),
  "expiresAt"   TIMESTAMPTZ(6),
  "revokedAt"   TIMESTAMPTZ(6),
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ApiKey_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "ApiKey_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE
);
CREATE INDEX "ApiKey_clientId_idx" ON "ApiKey" ("clientId");
CREATE INDEX "ApiKey_revokedAt_idx" ON "ApiKey" ("revokedAt");

CREATE TABLE "Webhook" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID,
  "name"        TEXT NOT NULL,
  "url"         TEXT NOT NULL,
  -- HMAC signing secret (raw, NOT a hash — we need to recompute the
  -- signature on every delivery). Stored encrypted at rest in v1.5;
  -- for v1 we accept plaintext to keep the wiring simple.
  "secret"      TEXT NOT NULL,
  -- Event types this webhook listens for. e.g. ['payroll.finalized',
  -- 'onboarding.task_completed', 'application.submitted'].
  "eventTypes"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isActive"    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "Webhook_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "Webhook_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "Webhook_clientId_active_idx" ON "Webhook" ("clientId", "isActive");

CREATE TABLE "WebhookDelivery" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "webhookId"    UUID NOT NULL,
  "eventType"    TEXT NOT NULL,
  "payload"      JSONB NOT NULL,
  "status"       "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMPTZ(6),
  "responseStatus" INTEGER,
  "responseBody" TEXT,
  "deliveredAt"  TIMESTAMPTZ(6),
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "WebhookDelivery_webhookId_fkey"
    FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE
);
CREATE INDEX "WebhookDelivery_webhookId_idx" ON "WebhookDelivery" ("webhookId");
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery" ("status");
