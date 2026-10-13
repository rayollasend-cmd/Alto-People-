-- Brief 1B-3: the reliability dashboard and its weekly summary.
--
-- Additive only. RouteUsageDaily gains a latency histogram (edges in
-- lib/usageTracker.ts) so p95 per route comes from our own rollup; rows
-- written before today keep an empty histogram and report a mean only.
ALTER TABLE "RouteUsageDaily" ADD COLUMN "histogram" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- One row per API process start, so restarts are a query rather than a
-- trip to the Railway console.
CREATE TABLE "ApiBoot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bootAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" VARCHAR(80) NOT NULL,
    "nodeVersion" VARCHAR(40) NOT NULL,

    CONSTRAINT "ApiBoot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApiBoot_bootAt_idx" ON "ApiBoot"("bootAt");

-- The scorecard for one closed org week, written by the weekly digest.
CREATE TABLE "ReliabilityWeek" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "weekStart" TIMESTAMPTZ(6) NOT NULL,
    "sentryErrors" INTEGER,
    "serverErrors" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "p95TopRoutes" JSONB NOT NULL DEFAULT '[]',
    "punchTotal" INTEGER NOT NULL DEFAULT 0,
    "punchAccepted" INTEGER NOT NULL DEFAULT 0,
    "rideTotal" INTEGER NOT NULL DEFAULT 0,
    "rideCompleted" INTEGER NOT NULL DEFAULT 0,
    "restarts" INTEGER NOT NULL DEFAULT 0,
    "underBudget" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReliabilityWeek_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReliabilityWeek_weekStart_key" ON "ReliabilityWeek"("weekStart");
