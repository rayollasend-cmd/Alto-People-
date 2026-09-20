-- A supervisor works ONE shift across every department they cover.
--
-- Alto staffs several departments in the same store, and StoreShiftSop was
-- unique on (locationId, label) — one SOP per shift window. So the second
-- department's SOP could not be attached at all, and storeShiftAt picked
-- candidates[0] and dropped the rest without a word: the checklist looked
-- complete because it was complete for ONE department.

-- 1. A window carries an SOP per department.
DROP INDEX IF EXISTS "StoreShiftSop_locationId_label_key";
CREATE UNIQUE INDEX IF NOT EXISTS "StoreShiftSop_locationId_label_templateId_key"
  ON "StoreShiftSop" ("locationId", "label", "templateId");
-- The old unique doubled as the lookup index for (locationId, label);
-- keep that access path now that the unique is wider.
CREATE INDEX IF NOT EXISTS "StoreShiftSop_locationId_label_idx"
  ON "StoreShiftSop" ("locationId", "label");

-- 2. The coverage ledger: every department a shift actually carried.
--    Backfilled from the single department each existing shift recorded,
--    so history reads consistently rather than as an empty set.
ALTER TABLE "OpsShift" ADD COLUMN IF NOT EXISTS "departments" TEXT[] NOT NULL DEFAULT '{}';
UPDATE "OpsShift" SET "departments" = ARRAY["department"] WHERE cardinality("departments") = 0;
