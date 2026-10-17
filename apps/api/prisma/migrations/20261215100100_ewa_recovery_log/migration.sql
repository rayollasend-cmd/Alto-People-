-- Each run's share of an earned-wage advance's recovery, so a draft that is
-- re-aggregated gives back its own share and no other run's.
ALTER TABLE "EarnedWageAdvance" ADD COLUMN "recoveryLog" JSONB NOT NULL DEFAULT '[]';
