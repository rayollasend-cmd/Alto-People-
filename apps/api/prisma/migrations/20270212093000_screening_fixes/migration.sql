-- Screening fixes (2026-11-03): a drug test obtained through a consumer
-- reporting agency is a consumer report, so failing someone on it takes the
-- same FCRA steps as a background check — the pre-adverse notice, a waiting
-- period, then the final notice. These columns hold where a test stands in
-- those steps. Additive and nullable: no existing row changes.
ALTER TABLE "DrugTest" ADD COLUMN IF NOT EXISTS "adjudication" VARCHAR(20);
ALTER TABLE "DrugTest" ADD COLUMN IF NOT EXISTS "preAdverseSentAt" TIMESTAMPTZ(6);
ALTER TABLE "DrugTest" ADD COLUMN IF NOT EXISTS "adverseWaitUntil" TIMESTAMPTZ(6);
ALTER TABLE "DrugTest" ADD COLUMN IF NOT EXISTS "adverseSentAt" TIMESTAMPTZ(6);
