-- seen vs read: opening the bell stamps seenAt (badge clears), clicking a
-- row stamps readAt (highlight clears). Existing read rows backfill as
-- seen — a row someone already clicked was necessarily seen.
ALTER TABLE "Notification" ADD COLUMN "seenAt" TIMESTAMPTZ(6);
UPDATE "Notification" SET "seenAt" = "readAt" WHERE "readAt" IS NOT NULL;
