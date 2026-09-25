-- Interviews that land in a calendar.
--
-- Scheduling an interview stored a time and told no one: the candidate
-- and the interviewer had to be told separately and put it in their own
-- calendars by hand. An interview now sends a calendar invite (.ics) to
-- both, and needs what an invite needs: how long it runs, where it is,
-- and a SEQUENCE so a reschedule or a cancel replaces the invite a
-- calendar already holds rather than adding a second one.

ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'INTERVIEW_RESCHEDULED';

ALTER TABLE "Interview" ADD COLUMN IF NOT EXISTS "durationMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Interview" ADD COLUMN IF NOT EXISTS "location" TEXT;
ALTER TABLE "Interview" ADD COLUMN IF NOT EXISTS "inviteSequence" INTEGER NOT NULL DEFAULT 0;
