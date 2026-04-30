-- Phase 5 follow-on — add WORKFORCE_MANAGER and MARKETING_MANAGER roles.
-- Same capability surface as HR_ADMINISTRATOR (granted in code, not the DB),
-- but distinct enum values so audit logs and access reviews can tell them
-- apart from HR.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'WORKFORCE_MANAGER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MARKETING_MANAGER';
