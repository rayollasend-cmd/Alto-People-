-- Per-shift staffing targets. A StaffingTarget row with NULL window
-- columns is the store's TOTAL floor target (existing rows keep their
-- meaning unchanged); a row with a label + start/end minutes is the
-- expected headcount for that shift window ("Morning 06:00-14:00 → 4").
-- Effective-dating applies per (location, label): the latest row
-- on-or-before a day wins within its label. endMinute <= startMinute
-- means the window wraps past midnight (same convention as ShiftTemplate).
ALTER TABLE "StaffingTarget" ADD COLUMN "label" TEXT;
ALTER TABLE "StaffingTarget" ADD COLUMN "startMinute" INTEGER;
ALTER TABLE "StaffingTarget" ADD COLUMN "endMinute" INTEGER;
