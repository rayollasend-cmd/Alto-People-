-- Phase 88 — OSHA incidents + Workers' Comp class codes + EEO-1.
--
-- Three things the compliance module hasn't covered yet:
--   OshaIncident                — federal OSHA 300/300A log entries.
--                                 Tracked from initial report through
--                                 medical / time-away outcomes.
--   WcClassCode + WcRate        — WC classification per state-and-class,
--                                 tied to JobProfile so cost rolls up.
--   EeoCategory + AssociateEeo  — EEO-1 race/ethnicity, gender, job
--                                 category capture for the annual report.

CREATE TYPE "OshaIncidentSeverity" AS ENUM (
  'FIRST_AID',
  'MEDICAL_TREATMENT',
  'RESTRICTED_DUTY',
  'DAYS_AWAY',
  'FATAL'
);

CREATE TYPE "OshaIncidentStatus" AS ENUM (
  'REPORTED',
  'INVESTIGATING',
  'RESOLVED',
  'ESCALATED'
);

CREATE TYPE "EeoCategory" AS ENUM (
  'EXEC_SR_OFFICIALS',
  'FIRST_MID_OFFICIALS',
  'PROFESSIONALS',
  'TECHNICIANS',
  'SALES_WORKERS',
  'ADMIN_SUPPORT',
  'CRAFT_WORKERS',
  'OPERATIVES',
  'LABORERS_HELPERS',
  'SERVICE_WORKERS'
);

CREATE TYPE "EeoRace" AS ENUM (
  'HISPANIC_LATINO',
  'WHITE',
  'BLACK_AFRICAN_AMERICAN',
  'NATIVE_HAWAIIAN_PACIFIC_ISLANDER',
  'ASIAN',
  'AMERICAN_INDIAN_ALASKA_NATIVE',
  'TWO_OR_MORE',
  'NOT_DISCLOSED'
);

CREATE TYPE "EeoGender" AS ENUM (
  'MALE',
  'FEMALE',
  'NON_BINARY',
  'NOT_DISCLOSED'
);

CREATE TABLE "OshaIncident" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"           UUID NOT NULL,
  "associateId"        UUID,
  "occurredAt"         TIMESTAMPTZ(6) NOT NULL,
  "reportedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "reportedById"       UUID,
  "location"           TEXT,
  "description"        TEXT NOT NULL,
  "bodyPart"           TEXT,
  "severity"           "OshaIncidentSeverity" NOT NULL,
  -- Counts of full days away from work and restricted-duty days. Drive
  -- the OSHA 300A annual summary calculation.
  "daysAway"           INTEGER NOT NULL DEFAULT 0,
  "daysRestricted"     INTEGER NOT NULL DEFAULT 0,
  "isRecordable"       BOOLEAN NOT NULL DEFAULT TRUE,
  "status"             "OshaIncidentStatus" NOT NULL DEFAULT 'REPORTED',
  "resolutionNote"     TEXT,
  "resolvedAt"         TIMESTAMPTZ(6),
  "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"          TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "OshaIncident_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "OshaIncident_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE SET NULL,
  CONSTRAINT "OshaIncident_reportedById_fkey"
    FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "OshaIncident_clientId_occurredAt_idx"
  ON "OshaIncident" ("clientId", "occurredAt" DESC);
CREATE INDEX "OshaIncident_status_idx" ON "OshaIncident" ("status");

CREATE TABLE "WcClassCode" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Two-letter state code; null = federal default rate (rare).
  "stateCode"   VARCHAR(2),
  -- NCCI / state-specific code, e.g. '8810' for clerical.
  "code"        VARCHAR(10) NOT NULL,
  "description" TEXT NOT NULL,
  -- Rate per $100 of payroll. Driven by the carrier; HR keeps current.
  "ratePer100"  DECIMAL(10, 4) NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo"   DATE,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "WcClassCode_unique"
    UNIQUE ("stateCode", "code", "effectiveFrom")
);
CREATE INDEX "WcClassCode_stateCode_idx" ON "WcClassCode" ("stateCode");

ALTER TABLE "JobProfile"
  ADD COLUMN "wcClassCode" VARCHAR(10);

CREATE TABLE "AssociateEeo" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"   UUID NOT NULL UNIQUE,
  "category"      "EeoCategory",
  "race"          "EeoRace",
  "gender"        "EeoGender",
  "isVeteran"     BOOLEAN,
  "isDisabled"    BOOLEAN,
  "selfDeclared"  BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AssociateEeo_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE
);
