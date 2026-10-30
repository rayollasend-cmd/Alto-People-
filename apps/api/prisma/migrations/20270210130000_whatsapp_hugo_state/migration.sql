-- Hugo on WhatsApp (Muse phase 6, lib/hugoWhatsapp): on an inbound question,
-- how it was answered (the registry at once, the quick or the strong model,
-- the registry as fallback, a task offer, a task started), the WATCH_* offer
-- that waits 30 minutes for the person's START reply, and the monthly
-- allowance notice. A nullable column: no existing row changes, no backfill.
-- The table is already under the tenant wall (row-level security).
ALTER TABLE "WhatsAppMessage" ADD COLUMN IF NOT EXISTS "hugo" JSONB;
