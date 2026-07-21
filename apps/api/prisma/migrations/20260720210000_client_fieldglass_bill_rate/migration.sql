-- Fieldglass client bill rate ($/hr) per SOW — the "Rate" column on the
-- Fieldglass timesheet accounting block (Amount = rate × hours). Nullable;
-- unset means the accounting Amount can't be computed.
ALTER TABLE "Client" ADD COLUMN "fieldglassBillRate" DECIMAL(8,2);
