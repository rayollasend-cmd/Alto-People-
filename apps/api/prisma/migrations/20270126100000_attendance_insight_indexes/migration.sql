-- Attendance insights read whole tenants by time: punches by clock-in, attendance events by day.
CREATE INDEX IF NOT EXISTS "TimeEntry_tenantId_clockInAt_idx" ON "TimeEntry"("tenantId", "clockInAt");
CREATE INDEX IF NOT EXISTS "AttendanceEvent_tenantId_occurredOn_idx" ON "AttendanceEvent"("tenantId", "occurredOn");
