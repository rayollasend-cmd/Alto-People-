-- Brief 3-4: labor-demand forecasting. A run per compute, a row per
-- site-week with its band and drivers, the signals people enter, and the
-- monthly scoring against verified hours. Every row carries its tenant.
CREATE TABLE "ForecastRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "method" VARCHAR(60) NOT NULL,
    "horizonWeeks" INTEGER NOT NULL,
    "anchorWeek" DATE NOT NULL,
    "trigger" VARCHAR(20) NOT NULL,
    "weights" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForecastRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ForecastRun_tenantId_generatedAt_idx" ON "ForecastRun"("tenantId", "generatedAt" DESC);

CREATE TABLE "ForecastSiteWeek" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "runId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "p10" DOUBLE PRECISION NOT NULL,
    "p50" DOUBLE PRECISION NOT NULL,
    "p90" DOUBLE PRECISION NOT NULL,
    "drivers" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "ForecastSiteWeek_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ForecastSiteWeek_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ForecastRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ForecastSiteWeek_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ForecastSiteWeek_runId_locationId_weekStart_key" ON "ForecastSiteWeek"("runId", "locationId", "weekStart");
CREATE INDEX "ForecastSiteWeek_tenantId_locationId_weekStart_idx" ON "ForecastSiteWeek"("tenantId", "locationId", "weekStart");

CREATE TABLE "ForecastSignal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "locationId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "factor" DOUBLE PRECISION NOT NULL,
    "source" VARCHAR(120),
    "note" VARCHAR(500),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ForecastSignal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ForecastSignal_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ForecastSignal_locationId_weekStart_kind_key" ON "ForecastSignal"("locationId", "weekStart", "kind");
CREATE INDEX "ForecastSignal_tenantId_locationId_idx" ON "ForecastSignal"("tenantId", "locationId");

CREATE TABLE "ForecastAccuracy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001',
    "locationId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "leadWeeks" INTEGER NOT NULL,
    "forecastP50" DOUBLE PRECISION NOT NULL,
    "actualHours" DOUBLE PRECISION NOT NULL,
    "absPctError" DOUBLE PRECISION NOT NULL,
    "runId" UUID,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForecastAccuracy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ForecastAccuracy_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ForecastAccuracy_locationId_weekStart_leadWeeks_key" ON "ForecastAccuracy"("locationId", "weekStart", "leadWeeks");
CREATE INDEX "ForecastAccuracy_tenantId_locationId_weekStart_idx" ON "ForecastAccuracy"("tenantId", "locationId", "weekStart");
