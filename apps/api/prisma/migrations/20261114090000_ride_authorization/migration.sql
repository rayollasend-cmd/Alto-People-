-- Brief 1A-3: ride charges only with a signed written authorization, at an
-- effective-dated rate, under a minimum-wage guard. Additive only.

-- The signed authorization on the consent row. Rows without signatureId are
-- legacy one-click consents: they authorize nothing from now on.
ALTER TABLE "RideConsent"
  ADD COLUMN IF NOT EXISTS "signatureId" UUID,
  ADD COLUMN IF NOT EXISTS "documentId" UUID,
  ADD COLUMN IF NOT EXISTS "version" INTEGER,
  ADD COLUMN IF NOT EXISTS "signedName" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "rateId" UUID,
  ADD COLUMN IF NOT EXISTS "withdrawnAt" TIMESTAMPTZ(6);

-- The effective-dated rate.
CREATE TABLE IF NOT EXISTS "TransportRate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "fareCents" INTEGER NOT NULL,
  "noShowFeeCents" INTEGER NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TransportRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TransportRate_effectiveFrom_idx" ON "TransportRate"("effectiveFrom");
CREATE INDEX IF NOT EXISTS "TransportRate_tenantId_idx" ON "TransportRate"("tenantId");

-- Seed the first rate from the settings row (or the defaults), dated so that
-- every ride already booked falls under it.
INSERT INTO "TransportRate" ("fareCents", "noShowFeeCents", "effectiveFrom", "createdById")
SELECT s."fareCents", s."noShowFeeCents", DATE '2024-01-01', s."updatedById"
FROM "TransportSettings" s
WHERE s."id" = 'default'
  AND NOT EXISTS (SELECT 1 FROM "TransportRate");

INSERT INTO "TransportRate" ("fareCents", "noShowFeeCents", "effectiveFrom")
SELECT 500, 100, DATE '2024-01-01'
WHERE NOT EXISTS (SELECT 1 FROM "TransportRate");

-- Which signature authorized a ride's charge.
ALTER TABLE "Ride" ADD COLUMN IF NOT EXISTS "authorizedSignatureId" UUID;

-- What each check took, what the guard deferred, and why.
ALTER TABLE "PayrollItem"
  ADD COLUMN IF NOT EXISTS "rideChargesCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rideChargesDeferredCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rideChargeGuard" JSONB;

-- Checks already paid: record the ride charges they took so the stub and
-- the year-to-date line keep adding up.
UPDATE "PayrollItem" pi
SET "rideChargesCents" = t.cents
FROM (
  SELECT "chargedItemId" AS item_id, SUM("chargeCents")::integer AS cents
  FROM "Ride"
  WHERE "chargedItemId" IS NOT NULL
  GROUP BY "chargedItemId"
) t
WHERE pi."id" = t.item_id AND pi."rideChargesCents" = 0;
