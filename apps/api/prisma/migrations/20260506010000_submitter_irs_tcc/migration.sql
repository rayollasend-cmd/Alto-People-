-- Gap 11 — IRS FIRE Transmitter Control Code on SubmitterProfile.
--
-- The TCC is the IRS's analog of the SSA BSO User ID — it's assigned
-- by the IRS when a transmitter registers for FIRE (Filing Information
-- Returns Electronically) and is required at the top of every 1099-NEC
-- e-file. Distinct from the BSO User ID (which authenticates W-2 SSA
-- uploads); a transmitter can hold both and they're not interchangeable.
--
-- Nullable: a company that only files W-2s doesn't need a TCC. The
-- 1099-NEC FIRE route 400s with submitter_tcc_missing when null and
-- the caller tries to generate the file.

ALTER TABLE "SubmitterProfile"
  ADD COLUMN "irsTcc" VARCHAR(5);
