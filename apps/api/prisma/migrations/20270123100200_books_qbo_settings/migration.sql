-- The company QuickBooks connection's own settings (how lines carry
-- Class and Location), instead of rows borrowed from the link table.
ALTER TABLE "QboCompanyConnection" ADD COLUMN "settings" JSONB;
