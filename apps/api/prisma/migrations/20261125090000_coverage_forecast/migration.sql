-- Agent families step 3 — the Workforce agent's coverage.forecast
-- (docs/agent-families-investigation.md §4). Additive: one table, written once a day,
-- never updated. The unique key has no nullable column, so a re-run skips.

-- CreateTable
CREATE TABLE "CoverageForecastDay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "locationId" UUID NOT NULL,
    "forecastOn" DATE NOT NULL,
    "targetDay" DATE NOT NULL,
    "leadDays" INTEGER NOT NULL,
    "demand" INTEGER NOT NULL,
    "assigned" INTEGER NOT NULL,
    "openShifts" INTEGER NOT NULL,
    "bench" INTEGER NOT NULL,
    "gap" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,

    CONSTRAINT "CoverageForecastDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoverageForecastDay_tenantId_forecastOn_idx" ON "CoverageForecastDay"("tenantId", "forecastOn");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageForecastDay_locationId_forecastOn_targetDay_key" ON "CoverageForecastDay"("locationId", "forecastOn", "targetDay");

-- AddForeignKey
ALTER TABLE "CoverageForecastDay" ADD CONSTRAINT "CoverageForecastDay_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "CoverageForecastDay" ADD CONSTRAINT "CoverageForecastDay_counts_check" CHECK ("leadDays" BETWEEN 0 AND 7 AND "demand" >= 0 AND "assigned" >= 0 AND "openShifts" >= 0 AND "bench" >= 0 AND "gap" >= 0);
