-- Onboarding overhaul: progress-reminder bookkeeping + per-task deadlines.

ALTER TABLE "Application" ADD COLUMN "progressRemindedAt" TIMESTAMPTZ(6);
ALTER TABLE "Application" ADD COLUMN "progressRemindCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "OnboardingTemplateTask" ADD COLUMN "dueOffsetDays" INTEGER;
ALTER TABLE "OnboardingTask" ADD COLUMN "dueOffsetDays" INTEGER;
