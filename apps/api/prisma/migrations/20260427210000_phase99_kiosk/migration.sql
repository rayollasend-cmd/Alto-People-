-- Phase 99 — Kiosk-mode clock in/out: 4-digit PIN + selfie.
--
-- Three tables:
--   KioskDevice — a registered tablet for one client. Holds a hashed
--                 device token (plaintext shown once at registration).
--   KioskPin    — per-(associate, client) 4-digit PIN. Stored as
--                 HMAC-SHA256(pin) using a server-side secret so the
--                 lookup is O(1) (unique on clientId+pinHmac) without
--                 leaking PINs from a DB dump alone.
--   KioskPunch  — forensic record of each kiosk transaction: selfie
--                 image, action, the TimeEntry it produced. Used to
--                 resolve buddy-punching disputes.

CREATE TABLE "KioskDevice" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID NOT NULL,
  "name"        TEXT NOT NULL,
  -- bcrypt hash of the plaintext device token. Plaintext is shown once.
  "tokenHash"   TEXT NOT NULL,
  "lastSeenAt"  TIMESTAMPTZ(6),
  "isActive"    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "KioskDevice_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "KioskDevice_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "KioskDevice_clientId_active_idx"
  ON "KioskDevice" ("clientId", "isActive");

CREATE TABLE "KioskPin" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId" UUID NOT NULL,
  "clientId"    UUID NOT NULL,
  -- 32-byte HMAC-SHA256 of the 4-digit PIN keyed with KIOSK_PIN_SECRET.
  "pinHmac"     BYTEA NOT NULL,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "KioskPin_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "KioskPin_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "KioskPin_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
-- One PIN per (client, associate) — re-issuing rotates the row.
CREATE UNIQUE INDEX "KioskPin_clientId_associateId_unique"
  ON "KioskPin" ("clientId", "associateId");
-- Within a client, no two associates can share a PIN. PIN generation
-- retries on collision.
CREATE UNIQUE INDEX "KioskPin_clientId_pinHmac_unique"
  ON "KioskPin" ("clientId", "pinHmac");

CREATE TYPE "KioskPunchAction" AS ENUM (
  'CLOCK_IN',
  'CLOCK_OUT',
  'REJECTED'
);

CREATE TABLE "KioskPunch" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "kioskDeviceId" UUID NOT NULL,
  "kioskPinId"    UUID,        -- null on REJECTED (PIN not found)
  "associateId"   UUID,         -- denormalized for fast HR lookup
  "timeEntryId"   UUID,         -- the entry created/closed by this punch
  "action"        "KioskPunchAction" NOT NULL,
  -- JPEG bytes of the selfie. ~50KB typical; we cap at 1MB in the API.
  "selfie"        BYTEA,
  "rejectReason"  TEXT,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "KioskPunch_kioskDeviceId_fkey"
    FOREIGN KEY ("kioskDeviceId") REFERENCES "KioskDevice"("id") ON DELETE CASCADE,
  CONSTRAINT "KioskPunch_kioskPinId_fkey"
    FOREIGN KEY ("kioskPinId") REFERENCES "KioskPin"("id") ON DELETE SET NULL,
  CONSTRAINT "KioskPunch_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE SET NULL,
  CONSTRAINT "KioskPunch_timeEntryId_fkey"
    FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE SET NULL
);
CREATE INDEX "KioskPunch_kioskDeviceId_idx" ON "KioskPunch" ("kioskDeviceId");
CREATE INDEX "KioskPunch_associateId_idx" ON "KioskPunch" ("associateId");
CREATE INDEX "KioskPunch_createdAt_idx" ON "KioskPunch" ("createdAt");
