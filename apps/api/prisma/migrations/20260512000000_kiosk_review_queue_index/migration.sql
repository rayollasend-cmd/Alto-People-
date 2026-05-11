-- HR's flagged-punch review queue lists PENDING punches in reverse
-- chronological order. Before this index, Postgres full-scanned
-- KioskPunch to find the handful with reviewStatus = 'PENDING'. As the
-- punch table grows (one row per associate per clock-in/out + breaks),
-- that scan moves from milliseconds to seconds. Partial index on the
-- rows that actually have a non-null reviewStatus keeps it tiny.

CREATE INDEX "KioskPunch_reviewStatus_createdAt_idx"
  ON "KioskPunch" ("reviewStatus", "createdAt" DESC);
