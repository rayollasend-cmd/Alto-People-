-- Brief 1A-2 — one effective-dated rate table per client and role.
--
-- ShiftRateDefault held one undated row per (client, position). It now
-- holds a history: a row is in force from effectiveFrom to effectiveTo
-- (inclusive; null = open-ended). Existing rows start on the day they were
-- created and stay open. Where a client's Fieldglass bill rate was the only
-- bill rate on file, it seeds the rows that had none.

ALTER TABLE "ShiftRateDefault" ADD COLUMN IF NOT EXISTS "effectiveFrom" DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE "ShiftRateDefault" ADD COLUMN IF NOT EXISTS "effectiveTo" DATE;
ALTER TABLE "ShiftRateDefault" ADD COLUMN IF NOT EXISTS "createdById" UUID;

UPDATE "ShiftRateDefault" SET "effectiveFrom" = ("createdAt" AT TIME ZONE 'America/New_York')::date;

UPDATE "ShiftRateDefault" d SET "billRate" = c."fieldglassBillRate"
  FROM "Client" c WHERE c."id" = d."clientId" AND d."billRate" IS NULL AND c."fieldglassBillRate" IS NOT NULL;

ALTER TABLE "ShiftRateDefault" DROP CONSTRAINT IF EXISTS "ShiftRateDefault_clientId_position_key";
DROP INDEX IF EXISTS "ShiftRateDefault_clientId_position_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ShiftRateDefault_clientId_position_effectiveFrom_key" ON "ShiftRateDefault"("clientId", "position", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "ShiftRateDefault_clientId_position_effectiveTo_idx" ON "ShiftRateDefault"("clientId", "position", "effectiveTo");
