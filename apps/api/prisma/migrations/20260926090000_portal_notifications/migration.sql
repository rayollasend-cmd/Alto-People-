-- Portal notifications: the store manager's bell, alerts and replies.

-- The name an invite addressed, so reminders greet the person, not the
-- front of their email address.
ALTER TABLE "User" ADD COLUMN "displayName" VARCHAR(120);

-- A request belongs to the store it was raised for: store managers see
-- and hear about their own store's requests, market accounts see all.
ALTER TABLE "ClientRequest" ADD COLUMN "locationId" UUID;
ALTER TABLE "ClientRequest" ADD CONSTRAINT "ClientRequest_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ClientRequest_locationId_idx" ON "ClientRequest"("locationId");

-- Backfill: existing requests take the store of the account that raised them.
UPDATE "ClientRequest" AS r
   SET "locationId" = u."locationId"
  FROM "User" AS u
 WHERE r."createdByUserId" = u."id"
   AND u."locationId" IS NOT NULL
   AND r."locationId" IS NULL;

-- One row per (account, alert key): a short-staffed wave rings each
-- person once, however many sweeps see it and across midnight.
CREATE TABLE "PortalAlertLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "alertKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PortalAlertLog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PortalAlertLog_userId_alertKey_key" ON "PortalAlertLog"("userId", "alertKey");
CREATE INDEX "PortalAlertLog_createdAt_idx" ON "PortalAlertLog"("createdAt");
ALTER TABLE "PortalAlertLog" ADD CONSTRAINT "PortalAlertLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
