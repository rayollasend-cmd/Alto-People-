-- Phase 102 — Offline kiosk punch queue.
--
-- When the kiosk loses connectivity, it queues punches locally and replays
-- them when the network returns. Two server-side fields make that safe:
--
--   idempotencyKey  client-generated UUIDv4 per punch attempt. If the
--                   server gets the same key twice (e.g., the kiosk
--                   retried after a flaky timeout), it returns the
--                   original punch result instead of double-clocking.
--
--   clientPunchedAt the wall-clock time the user actually pressed the
--                   button on the kiosk. When provided, we use it for
--                   the TimeEntry's clockInAt / clockOutAt instead of
--                   server's now() — otherwise a punch queued at 8:01am
--                   and synced at 11:30am would log as 11:30am.
--
-- The unique partial index on idempotencyKey allows NULL (legacy /
-- direct punches) without collision while enforcing dedup when present.

ALTER TABLE "KioskPunch"
    ADD COLUMN "idempotencyKey" TEXT,
    ADD COLUMN "clientPunchedAt" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "KioskPunch_idempotencyKey_key"
    ON "KioskPunch"("idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;
