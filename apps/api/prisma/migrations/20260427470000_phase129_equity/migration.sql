-- Phase 129 — Equity grants & vesting. Tracks RSU / NSO / ISO / phantom stock
-- grants per associate. The vesting schedule is denormalized into one row per
-- vesting "event" (e.g. cliff + 36 monthly tranches = 37 rows) so we can
-- report exact vested-as-of dates without recomputing from a formula at query
-- time — and so HR can manually adjust an event (e.g. accelerate) by simply
-- editing or inserting rows.
CREATE TYPE "EquityGrantType" AS ENUM (
  'RSU',
  'NSO',
  'ISO',
  'PHANTOM',
  'PERFORMANCE_RSU'
);

CREATE TYPE "EquityGrantStatus" AS ENUM (
  'PROPOSED',
  'GRANTED',
  'CANCELLED',
  'EXERCISED',
  'EXPIRED'
);

CREATE TABLE "EquityGrant" (
  "id"               UUID                 NOT NULL DEFAULT gen_random_uuid(),
  "associateId"      UUID                 NOT NULL,
  "grantType"        "EquityGrantType"    NOT NULL,
  "status"           "EquityGrantStatus"  NOT NULL DEFAULT 'PROPOSED',
  "totalShares"      INTEGER              NOT NULL,
  "strikePrice"      DECIMAL(12, 4),                            -- NSO/ISO only
  "currency"         VARCHAR(3)           NOT NULL DEFAULT 'USD',
  "grantDate"        DATE                 NOT NULL,
  "vestingStartDate" DATE                 NOT NULL,
  "cliffMonths"      INTEGER              NOT NULL DEFAULT 12,
  "vestingMonths"    INTEGER              NOT NULL DEFAULT 48,  -- total incl. cliff
  "expirationDate"   DATE,                                       -- options only
  "notes"            TEXT,
  "grantedById"      UUID,
  "createdAt"        TIMESTAMPTZ(6)       NOT NULL DEFAULT NOW(),
  "updatedAt"        TIMESTAMPTZ(6)       NOT NULL,
  CONSTRAINT "EquityGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EquityGrant_shares_check"  CHECK ("totalShares" > 0),
  CONSTRAINT "EquityGrant_cliff_check"   CHECK ("cliffMonths" >= 0 AND "cliffMonths" <= "vestingMonths"),
  CONSTRAINT "EquityGrant_vesting_check" CHECK ("vestingMonths" > 0)
);

CREATE INDEX "EquityGrant_associateId_idx" ON "EquityGrant"("associateId");
CREATE INDEX "EquityGrant_status_idx"      ON "EquityGrant"("status");

ALTER TABLE "EquityGrant" ADD CONSTRAINT "EquityGrant_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EquityGrant" ADD CONSTRAINT "EquityGrant_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One row per scheduled vesting event. shares is the slice that vests on
-- vestDate. eventIndex is the 0-based ordinal so we can re-derive monthly
-- order even if dates collide.
CREATE TABLE "EquityVestingEvent" (
  "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
  "grantId"     UUID            NOT NULL,
  "eventIndex"  INTEGER         NOT NULL,
  "vestDate"    DATE            NOT NULL,
  "shares"      INTEGER         NOT NULL,
  "isCliff"     BOOLEAN         NOT NULL DEFAULT FALSE,
  "createdAt"   TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "EquityVestingEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EquityVestingEvent_shares_check" CHECK ("shares" > 0)
);

CREATE INDEX "EquityVestingEvent_grantId_idx"  ON "EquityVestingEvent"("grantId");
CREATE INDEX "EquityVestingEvent_vestDate_idx" ON "EquityVestingEvent"("vestDate");
CREATE UNIQUE INDEX "EquityVestingEvent_grantId_eventIndex_key"
  ON "EquityVestingEvent"("grantId", "eventIndex");

ALTER TABLE "EquityVestingEvent" ADD CONSTRAINT "EquityVestingEvent_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "EquityGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
