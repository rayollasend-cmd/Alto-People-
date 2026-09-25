-- Undo and clean-up, part two. Idempotent — safe to re-run.

-- An application can be called off: sent in error, a hire undone, or an
-- invite that expired unanswered. Not a decision about the person.
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMPTZ(6);
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "cancelNote" TEXT;
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "cancelledById" UUID;
-- The invite email waiting out its Undo window.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "inviteEmailDueAt" TIMESTAMPTZ(6);
CREATE INDEX IF NOT EXISTS "Application_inviteEmailDueAt_idx" ON "Application"("inviteEmailDueAt") WHERE "inviteEmailDueAt" IS NOT NULL;
