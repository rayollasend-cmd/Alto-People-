-- Deep audit CODE-18 (builder PAY, 2026-10-29): claim-then-act for electronic
-- garnishment remittances. An electronic send stamps "sendingAt" on every
-- remittance it is about to put in an ACH file, in one conditional update; a
-- second send at the same moment matches nothing and is refused, so one
-- remittance is never in two files. Cleared when the send ends (sent or not).
--
-- Live data: additive and nullable. Every existing remittance reads NULL
-- ("not being sent") and behaves exactly as before. No rows are rewritten.
ALTER TABLE "GarnishmentRemittance" ADD COLUMN IF NOT EXISTS "sendingAt" TIMESTAMPTZ(6);
