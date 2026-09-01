-- Live-headshot onboarding task. Same ADD VALUE pattern as prior enum
-- growth (see 20260910120000_ops_closed_loop): IF NOT EXISTS keeps the
-- migration re-runnable across environments.
ALTER TYPE "TaskKind" ADD VALUE IF NOT EXISTS 'PROFILE_PHOTO';
