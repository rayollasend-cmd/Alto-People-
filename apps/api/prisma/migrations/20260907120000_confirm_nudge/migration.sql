-- "Please confirm your shift" chase marker (manual nudge-all + auto-nudge).
ALTER TABLE "Shift" ADD COLUMN "confirmNudgedAt" TIMESTAMPTZ(6);
