-- Phase 130 — Volunteer time off (VTO). Associates log hours volunteered for
-- a cause/org. HR approves; approved hours roll into an annual cap. If the
-- associate requested an employer match, HR can mark the entry MATCHED and
-- record the match amount. This is intentionally separate from PTO/reimburs-
-- ements: the unit of value is hours-impact, not days-off or dollars.
CREATE TYPE "VtoStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'MATCHED'
);

CREATE TABLE "VolunteerEntry" (
  "id"               UUID            NOT NULL DEFAULT gen_random_uuid(),
  "associateId"      UUID            NOT NULL,
  "activityDate"     DATE            NOT NULL,
  "hours"            DECIMAL(5, 2)   NOT NULL,
  "organization"     TEXT            NOT NULL,
  "cause"            TEXT,                                           -- free-text, e.g. "Hunger relief"
  "description"      TEXT            NOT NULL,
  "evidenceUrl"      TEXT,                                            -- link to photo / receipt / write-up
  "matchRequested"   BOOLEAN         NOT NULL DEFAULT FALSE,
  "matchAmount"      DECIMAL(10, 2),                                  -- set by HR on MATCHED
  "matchCurrency"    VARCHAR(3)      NOT NULL DEFAULT 'USD',
  "status"           "VtoStatus"     NOT NULL DEFAULT 'PENDING',
  "reviewedById"     UUID,
  "reviewedAt"       TIMESTAMPTZ(6),
  "reviewerNotes"    TEXT,
  "createdAt"        TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  "updatedAt"        TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "VolunteerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VolunteerEntry_hours_check" CHECK ("hours" > 0 AND "hours" <= 24)
);

CREATE INDEX "VolunteerEntry_associateId_idx"   ON "VolunteerEntry"("associateId");
CREATE INDEX "VolunteerEntry_status_idx"        ON "VolunteerEntry"("status");
CREATE INDEX "VolunteerEntry_activityDate_idx"  ON "VolunteerEntry"("activityDate");

ALTER TABLE "VolunteerEntry" ADD CONSTRAINT "VolunteerEntry_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VolunteerEntry" ADD CONSTRAINT "VolunteerEntry_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Per-client annual cap configuration. NULL clientId is the company-wide
-- default; per-client overrides win when set.
CREATE TABLE "VtoPolicy" (
  "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
  "clientId"        UUID,
  "annualHoursCap"  DECIMAL(6, 2)  NOT NULL DEFAULT 24,
  "matchRatio"      DECIMAL(4, 2)  NOT NULL DEFAULT 0,    -- $ per matched hour, 0 = no match offered
  "matchCurrency"   VARCHAR(3)     NOT NULL DEFAULT 'USD',
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "VtoPolicy_pkey" PRIMARY KEY ("id")
);

-- @unique on clientId (per-client uniqueness). Postgres allows multiple NULLs
-- in a unique index, so the route enforces "at most one global policy" via
-- findFirst+upsert against clientId IS NULL rather than via a constraint.
CREATE UNIQUE INDEX "VtoPolicy_clientId_key" ON "VtoPolicy"("clientId");

ALTER TABLE "VtoPolicy" ADD CONSTRAINT "VtoPolicy_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
