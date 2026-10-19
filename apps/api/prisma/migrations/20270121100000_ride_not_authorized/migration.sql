-- A ride that cost the rider nothing for one of two reasons, kept apart:
--   MANAGER         transportation waived it on purpose, with a reason;
--   NOT_AUTHORIZED  no current signed ride authorization when the driver
--                   marked it, so the law forbids the deduction.
-- uncollectedCents is what the ride would have cost (the fare, or the
-- no-show fee), so the money left on the table is reportable.

ALTER TABLE "Ride" ADD COLUMN "waiveKind" VARCHAR(16);
ALTER TABLE "Ride" ADD COLUMN "uncollectedCents" INTEGER NOT NULL DEFAULT 0;

UPDATE "Ride"
   SET "waiveKind" = 'NOT_AUTHORIZED',
       "uncollectedCents" = CASE WHEN "status" = 'NO_SHOW' THEN "noShowFeeCents" ELSE "fareCents" END
 WHERE "waivedAt" IS NOT NULL AND "waivedById" IS NULL AND "waiveReason" LIKE 'Not charged:%';

UPDATE "Ride"
   SET "waiveKind" = 'MANAGER'
 WHERE "waivedAt" IS NOT NULL AND "waiveKind" IS NULL;
