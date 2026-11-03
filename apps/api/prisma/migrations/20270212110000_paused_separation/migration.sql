-- Paused over 120 days becomes a separation (owner, 2026-11-03; lib/pausedSeparation.ts).
-- Two nullable stamps on Associate, additive only, no data rewritten:
--   pauseSeparationNoticeAt  HR's heads-up at 110 days paused (once per pause)
--   pauseSeparationHeldAt    the last time HR was told the rule couldn't separate
--                            someone (company property still out), so it repeats weekly
ALTER TABLE "Associate" ADD COLUMN IF NOT EXISTS "pauseSeparationNoticeAt" TIMESTAMPTZ(6);
ALTER TABLE "Associate" ADD COLUMN IF NOT EXISTS "pauseSeparationHeldAt" TIMESTAMPTZ(6);
