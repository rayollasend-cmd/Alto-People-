-- Phase 86 — Project time + premium pay + tip pooling.
--
-- Three additions:
--   Project              — coding dimension below Client/Job. TimeEntry
--                          gains a nullable projectId. Drives the Phase
--                          95 worktag system once those are in.
--   PremiumPayRule       — declarative shift-differential / OT-multiplier
--                          / holiday-pay rule. Applied at payroll-aggregate
--                          time to bump payRate on hours that match.
--   TipPool +            — per-shift / per-day tip pool with allocations
--   TipPoolAllocation      to participating associates. Stays separate
--                          from PayrollItem so the audit trail of who
--                          shared what is preserved.

CREATE TYPE "PremiumPayKind" AS ENUM (
  'OVERTIME_DAILY',
  'OVERTIME_WEEKLY',
  'NIGHT_DIFFERENTIAL',
  'WEEKEND_DIFFERENTIAL',
  'HOLIDAY',
  'SHIFT_DIFFERENTIAL',
  'CALL_BACK',
  'ON_CALL'
);

CREATE TYPE "TipPoolStatus" AS ENUM (
  'OPEN',
  'CLOSED',
  'PAID_OUT'
);

CREATE TABLE "Project" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID NOT NULL,
  "code"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  -- Optional billable flag; if FALSE, hours don't roll up to client invoicing.
  "isBillable"  BOOLEAN NOT NULL DEFAULT TRUE,
  "isActive"    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Project_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "Project_clientId_code_unique"
    UNIQUE ("clientId", "code")
);
CREATE INDEX "Project_clientId_isActive_idx"
  ON "Project" ("clientId", "isActive");

ALTER TABLE "TimeEntry"
  ADD COLUMN "projectId" UUID,
  ADD CONSTRAINT "TimeEntry_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL;
CREATE INDEX "TimeEntry_projectId_idx" ON "TimeEntry" ("projectId");

CREATE TABLE "PremiumPayRule" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"       UUID NOT NULL,
  "name"           TEXT NOT NULL,
  "kind"           "PremiumPayKind" NOT NULL,
  -- Multiplier applied to payRate (e.g. 1.5 for time-and-a-half).
  -- NULL when this rule uses a flat add (use addPerHour).
  "multiplier"     DECIMAL(4, 2),
  -- Flat $/hr add on top of base rate (e.g. $2/hr night differential).
  "addPerHour"     DECIMAL(8, 2),
  -- Threshold (hours) above which the rule triggers — only for OT kinds.
  -- e.g. dailyOT after 8 hrs in a day; weeklyOT after 40 in a week.
  "thresholdHours" DECIMAL(5, 2),
  -- Time window for differential rules (minute-of-day, 0..1440).
  "startMinute"    INTEGER,
  "endMinute"      INTEGER,
  -- Day-of-week mask; bit 0 = Sunday … bit 6 = Saturday. NULL = every day.
  "dowMask"        INTEGER,
  "isActive"       BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PremiumPayRule_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "PremiumPayRule_at_least_one_modifier_check"
    CHECK ("multiplier" IS NOT NULL OR "addPerHour" IS NOT NULL),
  CONSTRAINT "PremiumPayRule_threshold_positive_check"
    CHECK ("thresholdHours" IS NULL OR "thresholdHours" >= 0),
  CONSTRAINT "PremiumPayRule_window_check"
    CHECK (
      ("startMinute" IS NULL AND "endMinute" IS NULL)
      OR ("startMinute" BETWEEN 0 AND 1440 AND "endMinute" BETWEEN 0 AND 1440)
    )
);
CREATE INDEX "PremiumPayRule_clientId_isActive_idx"
  ON "PremiumPayRule" ("clientId", "isActive");

CREATE TABLE "TipPool" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"       UUID NOT NULL,
  "name"           TEXT NOT NULL,
  -- Date this pool covers (a tip night, a shift, a payroll period — up
  -- to the customer; we just store + sum + allocate).
  "shiftDate"      DATE NOT NULL,
  "totalAmount"    DECIMAL(12, 2) NOT NULL,
  "currency"       VARCHAR(3) NOT NULL DEFAULT 'USD',
  "status"         "TipPoolStatus" NOT NULL DEFAULT 'OPEN',
  "notes"          TEXT,
  "closedAt"       TIMESTAMPTZ(6),
  "paidOutAt"      TIMESTAMPTZ(6),
  "createdById"    UUID,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TipPool_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "TipPool_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "TipPool_total_check" CHECK ("totalAmount" >= 0)
);
CREATE INDEX "TipPool_clientId_shiftDate_idx"
  ON "TipPool" ("clientId", "shiftDate" DESC);

CREATE TABLE "TipPoolAllocation" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tipPoolId"      UUID NOT NULL,
  "associateId"    UUID NOT NULL,
  -- Either by hours-worked weight or by an explicit % share. Both stored
  -- so audits can see how the math was done.
  "hoursWorked"    DECIMAL(8, 2) NOT NULL DEFAULT 0,
  "sharePct"       DECIMAL(6, 3),
  -- Final $ amount allocated. Sum of these per pool == TipPool.totalAmount
  -- (validated when the pool is CLOSED; rounding goes to last allocation).
  "amount"         DECIMAL(12, 2) NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "TipPoolAllocation_tipPoolId_fkey"
    FOREIGN KEY ("tipPoolId") REFERENCES "TipPool"("id") ON DELETE CASCADE,
  CONSTRAINT "TipPoolAllocation_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "TipPoolAllocation_unique" UNIQUE ("tipPoolId", "associateId"),
  CONSTRAINT "TipPoolAllocation_amount_check" CHECK ("amount" >= 0),
  CONSTRAINT "TipPoolAllocation_share_check"
    CHECK ("sharePct" IS NULL OR ("sharePct" BETWEEN 0 AND 100))
);
CREATE INDEX "TipPoolAllocation_associateId_idx"
  ON "TipPoolAllocation" ("associateId");
