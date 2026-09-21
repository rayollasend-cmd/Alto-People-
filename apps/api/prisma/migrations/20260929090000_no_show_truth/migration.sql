-- No-call no-shows were being filed against people who worked.
--
-- The sweep wrote a NO_CALL_NO_SHOW attendance event 15 minutes after a
-- shift started if no punch was linked yet. An associate who badged in at
-- minute twenty, a kiosk that synced late, a timesheet keyed in that
-- evening, or a punch the matcher never linked all produced one — and
-- nothing ever withdrew it. Each carries 2.0 attendance points, so the
-- same defect that inflated the client's reliability card was proposing
-- discipline for people who showed up.
--
-- Two parts here: the stamp the split sweep needs, and a one-time
-- reconciliation of the events already on file.

-- ── 1. Separate stamp for "attendance event written" from "supervisor
-- alerted". The alert stays at 15 minutes; the event now waits for the
-- shift to end.
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "noShowRecordedAt" TIMESTAMPTZ(6);

-- ── 2. Withdraw every machine-written no-call no-show that the punch
-- record contradicts: the associate has a time entry overlapping the
-- shift they were marked absent from. Only source='AUTO' rows are
-- touched — an event a human recorded by hand stands.
--
-- These are deleted rather than excused. "Excused" reads as "they missed
-- it and we let it go", which is the same false statement about a person
-- who was on the floor; and the points must come off their rolling score.
DELETE FROM "AttendanceEvent" e
USING "Shift" s
WHERE e."shiftId" = s.id
  AND e.kind = 'NO_CALL_NO_SHOW'
  AND e.source = 'AUTO'
  AND EXISTS (
    SELECT 1
    FROM "TimeEntry" te
    WHERE te."associateId" = e."associateId"
      AND te."clockInAt" < s."endsAt"
      AND (te."clockOutAt" IS NULL OR te."clockOutAt" > s."startsAt")
  );

-- ── 3. Shifts that already ended keep their stamp so the record pass
-- doesn't re-file what step 2 just withdrew (or what a human excused).
UPDATE "Shift"
   SET "noShowRecordedAt" = COALESCE("noShowNotifiedAt", now())
 WHERE "noShowNotifiedAt" IS NOT NULL
   AND "noShowRecordedAt" IS NULL;
