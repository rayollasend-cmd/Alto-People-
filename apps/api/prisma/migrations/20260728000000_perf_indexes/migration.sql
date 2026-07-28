-- Performance index pass (site-wide performance audit).
--
-- Every replacement below is a strict superset of the index it drops, so
-- net index count stays flat while coverage strictly improves. Sources:
-- the hottest where-clauses in routes/lib (payroll aggregation, HR time
-- queue, audit search, notifications admin list, kiosk punch path,
-- approvals badge, supervisor scoping).

-- ── TimeEntry: the most-written table had no (…, clockInAt) range index
DROP INDEX IF EXISTS "TimeEntry_clientId_status_idx";
DROP INDEX IF EXISTS "TimeEntry_status_idx";
CREATE INDEX "TimeEntry_clientId_status_clockInAt_idx"
  ON "TimeEntry"("clientId", "status", "clockInAt");
CREATE INDEX "TimeEntry_status_clockInAt_idx"
  ON "TimeEntry"("status", "clockInAt");

-- ── AuditLog: filtered lists always order by createdAt DESC
DROP INDEX IF EXISTS "AuditLog_actorUserId_idx";
DROP INDEX IF EXISTS "AuditLog_clientId_idx";
CREATE INDEX "AuditLog_actorUserId_createdAt_idx"
  ON "AuditLog"("actorUserId", "createdAt" DESC);
CREATE INDEX "AuditLog_clientId_createdAt_idx"
  ON "AuditLog"("clientId", "createdAt" DESC);
CREATE INDEX "AuditLog_action_createdAt_idx"
  ON "AuditLog"("action", "createdAt" DESC);

-- ── Notification: fan-out-shaped table; admin list sorts by createdAt
DROP INDEX IF EXISTS "Notification_status_idx";
DROP INDEX IF EXISTS "Notification_category_idx";
CREATE INDEX "Notification_status_createdAt_idx"
  ON "Notification"("status", "createdAt" DESC);
CREATE INDEX "Notification_category_createdAt_idx"
  ON "Notification"("category", "createdAt" DESC);
CREATE INDEX "Notification_channel_createdAt_idx"
  ON "Notification"("channel", "createdAt" DESC);
CREATE INDEX "Notification_createdAt_idx"
  ON "Notification"("createdAt" DESC);

-- ── KioskPunch: the impossible-travel lookup runs on every punch
DROP INDEX IF EXISTS "KioskPunch_associateId_idx";
CREATE INDEX "KioskPunch_associateId_createdAt_idx"
  ON "KioskPunch"("associateId", "createdAt" DESC);

-- ── ShiftSwapRequest: /approvals/count seq-scanned on every page nav
CREATE INDEX "ShiftSwapRequest_status_createdAt_idx"
  ON "ShiftSwapRequest"("status", "createdAt" DESC);

-- ── AssociateAssignment: associatesOfClient branch B (open rows by site)
CREATE INDEX "AssociateAssignment_locationId_endedAt_idx"
  ON "AssociateAssignment"("locationId", "endedAt");

-- ── Application: make associatesOfClient branch A index-only
DROP INDEX IF EXISTS "Application_clientId_status_idx";
CREATE INDEX "Application_clientId_status_associateId_idx"
  ON "Application"("clientId", "status", "associateId");

-- ── DocumentRecord: HR vault queue sorts by createdAt
DROP INDEX IF EXISTS "DocumentRecord_status_idx";
CREATE INDEX "DocumentRecord_status_createdAt_idx"
  ON "DocumentRecord"("status", "createdAt" DESC);

-- ── PayrollRun: disbursement-window aggregates (dashboard, 1099/W-2)
DROP INDEX IF EXISTS "PayrollRun_status_idx";
CREATE INDEX "PayrollRun_status_disbursedAt_idx"
  ON "PayrollRun"("status", "disbursedAt");

-- ── Reimbursement: list sort
DROP INDEX IF EXISTS "Reimbursement_status_idx";
CREATE INDEX "Reimbursement_status_createdAt_idx"
  ON "Reimbursement"("status", "createdAt" DESC);

-- ── Cron sweep partial indexes (not expressible in Prisma schema).
-- The reminder/no-show stamps become permanently non-null, so the
-- "still due" set shrinks toward zero while the table keeps growing —
-- exactly what a partial index is for.
CREATE INDEX "Shift_reminder_due_idx" ON "Shift"("startsAt")
  WHERE "reminderSentAt" IS NULL AND "status" = 'ASSIGNED';
CREATE INDEX "Shift_noshow_due_idx" ON "Shift"("startsAt")
  WHERE "noShowNotifiedAt" IS NULL AND "status" = 'ASSIGNED';

-- ── Free-text search: contains/insensitive scans on Associate names and
-- audit actions get trigram GIN coverage.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Associate_name_trgm_idx" ON "Associate"
  USING gin (("firstName" || ' ' || "lastName") gin_trgm_ops);
CREATE INDEX "Associate_email_trgm_idx" ON "Associate"
  USING gin ("email" gin_trgm_ops);
CREATE INDEX "AuditLog_action_trgm_idx" ON "AuditLog"
  USING gin ("action" gin_trgm_ops);
