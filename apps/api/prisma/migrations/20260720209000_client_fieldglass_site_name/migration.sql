-- Verbatim SAP Fieldglass "Site" label per client engagement, rendered on the
-- Timesheets export so the Site column matches Fieldglass exactly. Nullable;
-- unset falls back to the worksite/client name.
ALTER TABLE "Client" ADD COLUMN "fieldglassSiteName" VARCHAR(255);
