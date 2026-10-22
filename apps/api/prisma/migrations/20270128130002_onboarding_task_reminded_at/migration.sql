-- Onboarding reminders: at most one reminder per task per 3 days, per person.
-- The last time the associate was reminded about each task.
ALTER TABLE "OnboardingTask" ADD COLUMN "remindedAt" TIMESTAMPTZ(6);
