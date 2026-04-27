-- Phase 105 — Kiosk break tracking.
--
-- Adds BREAK_START / BREAK_END to KioskPunchAction so the audit log
-- tells the full story (kiosk vs web vs manual edit). The actual break
-- timing lives on BreakEntry rows tied to the parent TimeEntry, where
-- payroll already reads it.
--
-- ALTER TYPE ... ADD VALUE can't run in the same transaction as DML in
-- some Postgres versions; it must commit before being usable. Prisma
-- runs each migration in its own transaction so this works as written.

ALTER TYPE "KioskPunchAction" ADD VALUE IF NOT EXISTS 'BREAK_START';
ALTER TYPE "KioskPunchAction" ADD VALUE IF NOT EXISTS 'BREAK_END';
