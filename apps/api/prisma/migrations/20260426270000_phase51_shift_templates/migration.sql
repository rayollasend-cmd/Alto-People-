-- Phase 51 — reusable shift templates (Friday closer, weekend opener, etc.)
-- + the apply / copy-week ergonomics around them.

CREATE TABLE "ShiftTemplate" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"     UUID,
  "name"         TEXT NOT NULL,
  "position"     TEXT NOT NULL,
  "dayOfWeek"    INTEGER NOT NULL CHECK ("dayOfWeek" >= 0 AND "dayOfWeek" <= 6),
  "startMinute"  INTEGER NOT NULL CHECK ("startMinute" >= 0 AND "startMinute" <= 1439),
  "endMinute"    INTEGER NOT NULL CHECK ("endMinute" >= 0 AND "endMinute" <= 1439),
  "location"     TEXT,
  "hourlyRate"   DECIMAL(8, 2),
  "payRate"      DECIMAL(8, 2),
  "notes"        TEXT,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"    TIMESTAMPTZ(6),
  CONSTRAINT "ShiftTemplate_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE
);

CREATE INDEX "ShiftTemplate_clientId_dayOfWeek_idx"
  ON "ShiftTemplate" ("clientId", "dayOfWeek");
CREATE INDEX "ShiftTemplate_deletedAt_idx"
  ON "ShiftTemplate" ("deletedAt");
