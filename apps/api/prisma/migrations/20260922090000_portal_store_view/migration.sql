-- The client portal as a store site: portal accounts scoped to one
-- Location (a store manager) or the whole client (a market manager),
-- billing disputes as a request kind that rings Finance, and the SLA /
-- owner fields the client sees on every request.

ALTER TABLE "User" ADD COLUMN "locationId" UUID;
ALTER TABLE "User"
    ADD CONSTRAINT "User_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "ClientRequestKind" ADD VALUE 'BILLING';

ALTER TABLE "ClientRequest" ADD COLUMN "dueAt" TIMESTAMPTZ(6);
ALTER TABLE "ClientRequest" ADD COLUMN "startedById" UUID;
ALTER TABLE "ClientRequest" ADD COLUMN "startedAt" TIMESTAMPTZ(6);
ALTER TABLE "ClientRequest"
    ADD CONSTRAINT "ClientRequest_startedById_fkey"
    FOREIGN KEY ("startedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the SLA clock on requests already in flight so the portal's
-- "due by" never renders blank for existing asks.
UPDATE "ClientRequest" SET "dueAt" = "createdAt" + INTERVAL '24 hours' WHERE "dueAt" IS NULL AND "kind" = 'STAFFING';
UPDATE "ClientRequest" SET "dueAt" = "createdAt" + INTERVAL '48 hours' WHERE "dueAt" IS NULL AND "kind" = 'ISSUE';
UPDATE "ClientRequest" SET "dueAt" = "createdAt" + INTERVAL '5 days' WHERE "dueAt" IS NULL AND "kind" = 'FEEDBACK';
