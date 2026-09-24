-- Real-user web vitals, rolled up per SPA route and UTC day. The histogram
-- is a fixed log-spaced bucket list whose edges live in lib/webVitals.ts;
-- p75 is a walk over it, never a scan of samples.
CREATE TABLE "WebVitalDaily" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day" DATE NOT NULL,
    "route" VARCHAR(200) NOT NULL,
    "metric" VARCHAR(8) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "sum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "good" INTEGER NOT NULL DEFAULT 0,
    "needsWork" INTEGER NOT NULL DEFAULT 0,
    "poor" INTEGER NOT NULL DEFAULT 0,
    "histogram" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "WebVitalDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebVitalDaily_day_route_metric_key" ON "WebVitalDaily"("day", "route", "metric");

CREATE INDEX "WebVitalDaily_day_idx" ON "WebVitalDaily"("day");
