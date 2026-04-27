-- Phase 83 — Compensation: effective-dated records, pay bands, merit cycles.
--
-- Three additive tables:
--   CompensationRecord  — effective-dated pay history per associate.
--                         The current row mirrors associate.hourlyRate /
--                         payRate today; over time those denorms become
--                         derived from this table.
--   CompBand            — minimum / midpoint / maximum pay for a band,
--                         optionally tied to a JobProfile. Lets HR see
--                         "where in band" each associate sits.
--   MeritCycle +        — annual / quarterly review cycle with one
--   MeritProposal         proposal per eligible associate. Apply step
--                         writes all APPROVED proposals as new
--                         CompensationRecords on the cycle's effective
--                         date.

CREATE TYPE "PayType" AS ENUM ('HOURLY', 'SALARY');

CREATE TYPE "CompChangeReason" AS ENUM (
  'HIRE',
  'MERIT',
  'PROMOTION',
  'MARKET_ADJUSTMENT',
  'CORRECTION',
  'OTHER'
);

CREATE TYPE "MeritCycleStatus" AS ENUM (
  'DRAFT',
  'OPEN',
  'APPLIED',
  'CLOSED'
);

CREATE TYPE "MeritProposalStatus" AS ENUM (
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'APPLIED'
);

CREATE TABLE "CompensationRecord" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"    UUID NOT NULL,
  "effectiveFrom"  TIMESTAMPTZ(6) NOT NULL,
  "effectiveTo"    TIMESTAMPTZ(6),
  "payType"        "PayType" NOT NULL,
  -- Hourly rate or annual salary. Always > 0.
  "amount"         DECIMAL(12, 2) NOT NULL,
  "currency"       VARCHAR(3) NOT NULL DEFAULT 'USD',
  "reason"         "CompChangeReason" NOT NULL,
  "notes"          TEXT,
  "actorUserId"    UUID,
  "meritProposalId" UUID,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "CompensationRecord_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "CompensationRecord_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "CompensationRecord_amount_check" CHECK ("amount" > 0)
);
CREATE INDEX "CompensationRecord_associateId_effectiveFrom_idx"
  ON "CompensationRecord" ("associateId", "effectiveFrom" DESC);
-- At most one CURRENT comp row per associate (effectiveTo IS NULL).
CREATE UNIQUE INDEX "CompensationRecord_associateId_current_unique"
  ON "CompensationRecord" ("associateId")
  WHERE "effectiveTo" IS NULL;

CREATE TABLE "CompBand" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"       UUID NOT NULL,
  "jobProfileId"   UUID,
  "name"           TEXT NOT NULL,
  "level"          TEXT,
  "payType"        "PayType" NOT NULL,
  "minAmount"      DECIMAL(12, 2) NOT NULL,
  "midAmount"      DECIMAL(12, 2) NOT NULL,
  "maxAmount"      DECIMAL(12, 2) NOT NULL,
  "currency"       VARCHAR(3) NOT NULL DEFAULT 'USD',
  "effectiveFrom"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "effectiveTo"    TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"      TIMESTAMPTZ(6),
  CONSTRAINT "CompBand_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "CompBand_jobProfileId_fkey"
    FOREIGN KEY ("jobProfileId") REFERENCES "JobProfile"("id") ON DELETE SET NULL,
  CONSTRAINT "CompBand_min_lt_mid_check" CHECK ("minAmount" <= "midAmount"),
  CONSTRAINT "CompBand_mid_lt_max_check" CHECK ("midAmount" <= "maxAmount")
);
CREATE INDEX "CompBand_clientId_idx" ON "CompBand" ("clientId");
CREATE INDEX "CompBand_jobProfileId_idx" ON "CompBand" ("jobProfileId");

CREATE TABLE "MeritCycle" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"           UUID NOT NULL,
  "name"               TEXT NOT NULL,
  "status"             "MeritCycleStatus" NOT NULL DEFAULT 'DRAFT',
  -- Window of work covered (the merit period). Used to filter eligible
  -- associates (must have been active for some part of this window).
  "reviewPeriodStart"  DATE NOT NULL,
  "reviewPeriodEnd"    DATE NOT NULL,
  -- The date new comp records will be opened with effectiveFrom = this.
  "effectiveDate"      DATE NOT NULL,
  -- Optional budget cap for the cycle (sum of approved increases must
  -- be <= this when applied).
  "budget"             DECIMAL(12, 2),
  "appliedAt"          TIMESTAMPTZ(6),
  "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"          TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "MeritCycle_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "MeritCycle_period_check"
    CHECK ("reviewPeriodEnd" >= "reviewPeriodStart")
);
CREATE INDEX "MeritCycle_clientId_status_idx"
  ON "MeritCycle" ("clientId", "status");

CREATE TABLE "MeritProposal" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "cycleId"          UUID NOT NULL,
  "associateId"      UUID NOT NULL,
  -- Snapshot at proposal time so the final apply step can detect
  -- comp-changed-mid-cycle (we then reject as STALE on apply).
  "currentAmount"    DECIMAL(12, 2) NOT NULL,
  "currentPayType"   "PayType" NOT NULL,
  "proposedAmount"   DECIMAL(12, 2) NOT NULL,
  "proposedNotes"    TEXT,
  "status"           "MeritProposalStatus" NOT NULL DEFAULT 'DRAFT',
  "proposedById"     UUID,
  "decidedById"      UUID,
  "decidedAt"        TIMESTAMPTZ(6),
  "decisionNote"     TEXT,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "MeritProposal_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "MeritCycle"("id") ON DELETE CASCADE,
  CONSTRAINT "MeritProposal_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "MeritProposal_proposedById_fkey"
    FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "MeritProposal_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "MeritProposal_proposedAmount_check" CHECK ("proposedAmount" > 0),
  CONSTRAINT "MeritProposal_unique_per_cycle"
    UNIQUE ("cycleId", "associateId")
);
CREATE INDEX "MeritProposal_cycleId_status_idx"
  ON "MeritProposal" ("cycleId", "status");

-- Backfill: every existing Associate gets a HIRE row so /comp endpoints
-- return something. We use the most recent associate.hourlyRate from the
-- denorm if non-null, else default to 0.01 (still satisfies amount > 0
-- without blocking the migration on missing data).
INSERT INTO "CompensationRecord"
  ("associateId", "effectiveFrom", "payType", "amount", "reason", "createdAt")
SELECT
  a."id",
  a."createdAt",
  'HOURLY'::"PayType",
  GREATEST(COALESCE(
    (SELECT ph."hourlyRate"
       FROM "AssociateHistory" ph
       WHERE ph."associateId" = a."id" AND ph."hourlyRate" IS NOT NULL
       ORDER BY ph."effectiveFrom" DESC
       LIMIT 1),
    0.01
  ), 0.01),
  'HIRE'::"CompChangeReason",
  a."createdAt"
FROM "Associate" a
WHERE a."deletedAt" IS NULL;

-- FK from CompensationRecord.meritProposalId — added after MeritProposal
-- table exists.
ALTER TABLE "CompensationRecord"
  ADD CONSTRAINT "CompensationRecord_meritProposalId_fkey"
  FOREIGN KEY ("meritProposalId")
  REFERENCES "MeritProposal"("id") ON DELETE SET NULL;
