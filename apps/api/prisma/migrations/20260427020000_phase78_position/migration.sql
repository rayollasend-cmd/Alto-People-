-- Phase 78 — Position model.
--
-- A Position is an authorized seat that may or may not be filled by an
-- Associate. Headcount budgeting works at the Position level; recruiting
-- requisitions (Phase 90) attach to a Position; attrition reporting
-- compares Position.fteAuthorized vs filled.

CREATE TYPE "PositionStatus" AS ENUM (
  'PLANNED',  -- approved for next budget cycle, not yet open to hire
  'OPEN',     -- accepting candidates
  'FILLED',   -- an Associate is assigned
  'FROZEN',   -- on hold (hiring freeze, restructure)
  'CLOSED'    -- retired
);

CREATE TABLE "Position" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"         UUID NOT NULL,
  "code"             TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "jobProfileId"     UUID,
  "departmentId"     UUID,
  "costCenterId"     UUID,
  "managerAssociateId" UUID,
  -- 1.0 = full-time, 0.5 = half-time, etc. Used for headcount math.
  "fteAuthorized"    DECIMAL(4, 2) NOT NULL DEFAULT 1.00,
  "status"           "PositionStatus" NOT NULL DEFAULT 'PLANNED',
  -- The Associate currently filling the position. Null = vacancy.
  "filledByAssociateId" UUID,
  "filledAt"         TIMESTAMPTZ(6),
  -- For planned positions: target start date so headcount roll-up
  -- can show "12 positions filling next quarter."
  "targetStartDate"  DATE,
  -- Authorized comp band — actual offer / pay lives on Associate.
  "minHourlyRate"    DECIMAL(8, 2),
  "maxHourlyRate"    DECIMAL(8, 2),
  "notes"            TEXT,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"        TIMESTAMPTZ(6),
  CONSTRAINT "Position_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "Position_jobProfileId_fkey"
    FOREIGN KEY ("jobProfileId") REFERENCES "JobProfile"("id") ON DELETE SET NULL,
  CONSTRAINT "Position_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL,
  CONSTRAINT "Position_costCenterId_fkey"
    FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL,
  CONSTRAINT "Position_managerAssociateId_fkey"
    FOREIGN KEY ("managerAssociateId") REFERENCES "Associate"("id") ON DELETE SET NULL,
  CONSTRAINT "Position_filledByAssociateId_fkey"
    FOREIGN KEY ("filledByAssociateId") REFERENCES "Associate"("id") ON DELETE SET NULL,
  -- A position may be filled by at most one associate at a time.
  -- The same associate can also hold multiple positions (rare but legal).
  CONSTRAINT "Position_filled_status_check"
    CHECK (
      ("status" = 'FILLED'  AND "filledByAssociateId" IS NOT NULL) OR
      ("status" <> 'FILLED' AND "filledByAssociateId" IS NULL)
    )
);

CREATE UNIQUE INDEX "Position_clientId_code_key"
  ON "Position" ("clientId", "code")
  WHERE "deletedAt" IS NULL;
CREATE INDEX "Position_clientId_status_idx" ON "Position" ("clientId", "status");
CREATE INDEX "Position_filledByAssociateId_idx" ON "Position" ("filledByAssociateId");
CREATE INDEX "Position_departmentId_idx" ON "Position" ("departmentId");
CREATE INDEX "Position_costCenterId_idx" ON "Position" ("costCenterId");
CREATE INDEX "Position_managerAssociateId_idx" ON "Position" ("managerAssociateId");
CREATE INDEX "Position_deletedAt_idx" ON "Position" ("deletedAt");
