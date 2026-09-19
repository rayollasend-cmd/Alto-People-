-- Walmart's temperature limits on the seeded SOPs: refrigerated at or below
-- 40°F, frozen at or below 0°F. Only checks still on the seed's values move
-- — a range an admin set by hand stays theirs. Runs already opened keep the
-- limits they were opened with.

-- Freezer cases and frozen loads: ≤10°F → ≤0°F.
UPDATE "OpsSopTemplateTask" t
SET "tempMin" = -30, "tempMax" = 0
FROM "OpsSopTemplate" o
WHERE o.id = t."templateId"
  AND o.department IN ('Frozen & Dairy', 'Food & Consumables', 'Meat & Produce')
  AND t."responseType" = 'TEMPERATURE'
  AND t."tempMin" = -20 AND t."tempMax" = 10;

-- Dairy, produce and deli coolers, cold cases, refrigerated loads: ≤41°F → ≤40°F.
UPDATE "OpsSopTemplateTask" t
SET "tempMin" = 32, "tempMax" = 40
FROM "OpsSopTemplate" o
WHERE o.id = t."templateId"
  AND o.department IN ('Frozen & Dairy', 'Food & Consumables', 'Meat & Produce', 'Deli & Bakery')
  AND t."responseType" = 'TEMPERATURE'
  AND t."tempMax" = 41 AND t."tempMin" IN (32, 33);

UPDATE "OpsSopTemplateTask" t
SET "tempMax" = 40
FROM "OpsSopTemplate" o
WHERE o.id = t."templateId"
  AND o.department IN ('Frozen & Dairy', 'Meat & Produce')
  AND t."responseType" = 'TEMPERATURE'
  AND t."tempMin" = 28 AND t."tempMax" = 41;
