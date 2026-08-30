-- Dormancy sweep (lib/dormancySweep.ts): auto-deactivate associates with
-- no clock-ins, worked shifts, upcoming shifts, claims, or approved leave
-- for DORMANCY_DEACTIVATE_DAYS (default 30), after a standing warning.

-- Warning stamp — stale (and re-armed) whenever activity postdates it.
ALTER TABLE "Associate" ADD COLUMN "dormancyWarnedAt" TIMESTAMPTZ(6);

-- Reactivation stamp — grants a fresh dormancy window after Reactivate.
ALTER TABLE "Associate" ADD COLUMN "reactivatedAt" TIMESTAMPTZ(6);
