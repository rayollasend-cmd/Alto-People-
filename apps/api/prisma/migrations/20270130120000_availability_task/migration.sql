-- The onboarding checklist asks a new hire when they can work (role walk
-- supervisor 11). Enum values are additive; existing rows are untouched.
ALTER TYPE "TaskKind" ADD VALUE 'AVAILABILITY';
