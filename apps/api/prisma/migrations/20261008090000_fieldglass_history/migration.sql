-- The Fieldglass Security ID's fallback for a worker with no SSN: the last
-- 4 of their passport / travel document number.
ALTER TABLE "Associate" ADD COLUMN "travelDocLast4" VARCHAR(4);

-- A week's Fieldglass timesheet, over time: the buyer's comment (a
-- rejection reason), when a rejected one was resubmitted, finance's note.
ALTER TABLE "FieldglassTimesheet" ADD COLUMN "fgComment" VARCHAR(500);
ALTER TABLE "FieldglassTimesheet" ADD COLUMN "resubmittedAt" TIMESTAMPTZ(6);
ALTER TABLE "FieldglassTimesheet" ADD COLUMN "note" VARCHAR(500);

-- An associate's whole history is read by associate, newest week first.
CREATE INDEX "FieldglassTimesheet_associateId_weekStart_idx" ON "FieldglassTimesheet"("associateId", "weekStart");
