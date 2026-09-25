-- Undo and clean-up: a hire can be taken back before the person starts, a
-- mistaken onboarding invite can be cancelled without a "declined" email,
-- untouched invites and quiet candidates close on their own, and a
-- candidate can be removed and restored. Idempotent — safe to re-run.

ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'HIRE_UNDONE';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'REMOVED';
ALTER TYPE "CandidateEventKind" ADD VALUE IF NOT EXISTS 'RESTORED';
