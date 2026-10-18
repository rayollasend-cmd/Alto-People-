-- Native apps (iOS / Android): the phones a person has the app on, the
-- one-time codes that carry a system-browser sign-in (SSO, passkeys) back
-- into the app, and a version on each clock-in number so a lost NFC badge
-- or Wallet pass can be reissued (the old one stops working at once).

CREATE TYPE "NativePlatform" AS ENUM ('IOS', 'ANDROID');

CREATE TABLE "NativeDevice" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"            UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId"              UUID NOT NULL,
  "platform"            "NativePlatform" NOT NULL,
  -- APNs device token (iOS) or FCM registration token (Android). NULL until
  -- the person allows notifications; the row still holds the device credential.
  "pushToken"           VARCHAR(400),
  "deviceName"          VARCHAR(120),
  "deviceModel"         VARCHAR(120),
  "osVersion"           VARCHAR(40),
  "appVersion"          VARCHAR(40),
  -- A refresh credential kept in the phone's Keychain / Keystore: only its
  -- hash is stored. It re-opens a session the web view lost, and dies with
  -- sign-out, a password change (tokenVersion) or its own expiry.
  "credentialHash"      BYTEA,
  "credentialExpiresAt" TIMESTAMPTZ(6),
  "tokenVersion"        INTEGER NOT NULL DEFAULT 0,
  "biometricLock"       BOOLEAN NOT NULL DEFAULT false,
  "lastSeenAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"           TIMESTAMPTZ(6),
  "createdAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NativeDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NativeDevice_pushToken_key" ON "NativeDevice"("pushToken");
CREATE INDEX "NativeDevice_userId_revokedAt_idx" ON "NativeDevice"("userId", "revokedAt");
CREATE INDEX "NativeDevice_tenantId_idx" ON "NativeDevice"("tenantId");
ALTER TABLE "NativeDevice"
  ADD CONSTRAINT "NativeDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "NativeHandoffCode" (
  "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"  UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "userId"    UUID NOT NULL,
  "codeHash"  BYTEA NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "usedAt"    TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NativeHandoffCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NativeHandoffCode_codeHash_key" ON "NativeHandoffCode"("codeHash");
CREATE INDEX "NativeHandoffCode_expiresAt_idx" ON "NativeHandoffCode"("expiresAt");
CREATE INDEX "NativeHandoffCode_tenantId_idx" ON "NativeHandoffCode"("tenantId");
ALTER TABLE "NativeHandoffCode"
  ADD CONSTRAINT "NativeHandoffCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A badge (NFC tag or Wallet pass QR) carries this version; reissuing bumps it.
ALTER TABLE "KioskPin" ADD COLUMN "badgeVersion" INTEGER NOT NULL DEFAULT 1;
