-- F500 G4 (Reports): when a saved report last ran — by hand from the list
-- or by a schedule's delivery — so the saved-reports list can say so.
-- A nullable column on an existing tenant table: no new RLS wall needed.
ALTER TABLE "Report" ADD COLUMN "lastRunAt" TIMESTAMPTZ(6);
