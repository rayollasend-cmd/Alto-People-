-- Brief 2-1b, step 3: Client becomes optional on the fifteen models a direct
-- employer (a hotel with no clients) needs. Additive: no row changes, the
-- foreign keys stay, only the NOT NULL goes.
--
-- The owner's ruling on risk 3: every unique constraint keyed on a now-
-- nullable clientId gets its partial twin IN THIS MIGRATION, because
-- PostgreSQL treats NULLs as distinct in a unique index and would otherwise
-- allow duplicate client-less rows. The migration is not complete without
-- them.

ALTER TABLE "Location"              ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "Application"           ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "Shift"                 ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "ShiftTeam"             ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "SchedulingRosterOrder" ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "ClockInRequest"        ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "KioskDevice"           ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "KioskPin"              ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "ShiftPosition"         ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "ShiftRateDefault"      ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "Department"            ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "CostCenter"            ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "Position"              ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "JobProfile"            ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "Offer"                 ALTER COLUMN "clientId" DROP NOT NULL;

-- One client-less row per tenant for each key the unique constraints guard.
CREATE UNIQUE INDEX IF NOT EXISTS "SchedulingRosterOrder_noclient_associate_key"
  ON "SchedulingRosterOrder" ("tenantId", "associateId") WHERE "clientId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ShiftRateDefault_noclient_position_effectiveFrom_key"
  ON "ShiftRateDefault" ("tenantId", "position", "effectiveFrom") WHERE "clientId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "OnboardingTemplate_noclient_track_key"
  ON "OnboardingTemplate" ("tenantId", "track") WHERE "clientId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ComplianceScoreSnapshot_noclient_day_key"
  ON "ComplianceScoreSnapshot" ("tenantId", "day") WHERE "clientId" IS NULL;
