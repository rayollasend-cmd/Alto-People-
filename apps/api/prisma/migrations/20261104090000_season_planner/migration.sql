-- Brief 1C-3: the Season Planner. Two additive tables; nothing existing
-- changes. A plan is a scenario of inputs; every output is computed on read.

CREATE TABLE "SeasonPlan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "clientId" UUID,
    "seasonStart" DATE NOT NULL,
    "seasonEnd" DATE NOT NULL,
    "targetHoursPerWeek" INTEGER NOT NULL DEFAULT 40,
    "shiftHours" INTEGER NOT NULL DEFAULT 8,
    "reservePct" INTEGER NOT NULL DEFAULT 10,
    "channelMix" JSONB NOT NULL DEFAULT '{"LOCAL":25,"J1_NORTH":35,"J1_SOUTH":15,"H2B":25}',
    "arrivalLeadWeeks" JSONB NOT NULL DEFAULT '{"LOCAL":3,"J1_NORTH":10,"J1_SOUTH":12,"H2B":20}',
    "housingShare" JSONB NOT NULL DEFAULT '{"LOCAL":0,"J1_NORTH":100,"J1_SOUTH":100,"H2B":100}',
    "rideShare" JSONB NOT NULL DEFAULT '{"LOCAL":10,"J1_NORTH":100,"J1_SOUTH":100,"H2B":100}',
    "notes" VARCHAR(2000),
    "createdById" UUID,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SeasonPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SeasonPlan_clientId_seasonStart_idx" ON "SeasonPlan"("clientId", "seasonStart");
CREATE INDEX "SeasonPlan_archivedAt_updatedAt_idx" ON "SeasonPlan"("archivedAt", "updatedAt" DESC);

ALTER TABLE "SeasonPlan" ADD CONSTRAINT "SeasonPlan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SeasonPlanSite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "planId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "bedsAvailable" INTEGER NOT NULL DEFAULT 0,
    "vanSeatsPerRun" INTEGER NOT NULL DEFAULT 14,
    "runsPerShift" INTEGER NOT NULL DEFAULT 1,
    "routeMinutes" INTEGER NOT NULL DEFAULT 45,
    "demand" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "SeasonPlanSite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeasonPlanSite_planId_locationId_key" ON "SeasonPlanSite"("planId", "locationId");

ALTER TABLE "SeasonPlanSite" ADD CONSTRAINT "SeasonPlanSite_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SeasonPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeasonPlanSite" ADD CONSTRAINT "SeasonPlanSite_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
