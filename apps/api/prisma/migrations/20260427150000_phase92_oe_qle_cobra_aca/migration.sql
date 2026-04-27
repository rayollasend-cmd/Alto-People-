-- Phase 92 — Open enrollment, qualifying life events, COBRA, ACA reporting.

CREATE TYPE "OpenEnrollmentStatus" AS ENUM (
  'DRAFT',
  'OPEN',
  'CLOSED'
);

CREATE TYPE "QleKind" AS ENUM (
  'MARRIAGE',
  'DIVORCE',
  'BIRTH',
  'ADOPTION',
  'DEATH_OF_DEPENDENT',
  'LOSS_OF_COVERAGE',
  'GAIN_OF_COVERAGE',
  'RELOCATION',
  'OTHER'
);

CREATE TYPE "QleStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'DENIED',
  'EXPIRED'
);

CREATE TYPE "CobraStatus" AS ENUM (
  'NOTIFIED',
  'ELECTED',
  'WAIVED',
  'EXPIRED',
  'TERMINATED'
);

CREATE TYPE "AcaCoverageOffer" AS ENUM (
  'CODE_1A',
  'CODE_1B',
  'CODE_1C',
  'CODE_1D',
  'CODE_1E',
  'CODE_1F',
  'CODE_1G',
  'CODE_1H'
);

CREATE TABLE "OpenEnrollmentWindow" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"    UUID NOT NULL,
  "name"        TEXT NOT NULL,
  "startsOn"    DATE NOT NULL,
  "endsOn"      DATE NOT NULL,
  "effectiveOn" DATE NOT NULL,
  "status"      "OpenEnrollmentStatus" NOT NULL DEFAULT 'DRAFT',
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "OpenEnrollmentWindow_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "OpenEnrollmentWindow_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "OpenEnrollmentWindow_dates_check" CHECK ("startsOn" <= "endsOn")
);
CREATE INDEX "OpenEnrollmentWindow_clientId_status_idx"
  ON "OpenEnrollmentWindow" ("clientId", "status");

CREATE TABLE "QualifyingLifeEvent" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"  UUID NOT NULL,
  "kind"         "QleKind" NOT NULL,
  "eventDate"    DATE NOT NULL,
  -- Window during which the associate may make benefit changes (typically
  -- 30 or 60 days from eventDate). After this passes the QLE auto-expires
  -- if not yet APPROVED.
  "allowedUntil" DATE NOT NULL,
  "evidenceUrl"  TEXT,
  "notes"        TEXT,
  "status"       "QleStatus" NOT NULL DEFAULT 'PENDING',
  "decidedAt"    TIMESTAMPTZ(6),
  "decidedById"  UUID,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "QualifyingLifeEvent_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "QualifyingLifeEvent_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "QualifyingLifeEvent_associateId_idx"
  ON "QualifyingLifeEvent" ("associateId");
CREATE INDEX "QualifyingLifeEvent_status_idx"
  ON "QualifyingLifeEvent" ("status");

CREATE TABLE "CobraOffer" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"      UUID NOT NULL,
  "qualifyingEvent"  TEXT NOT NULL, -- e.g. 'TERMINATION', 'REDUCTION_OF_HOURS'
  "qeDate"           DATE NOT NULL,
  -- 60-day election window from the later of (notice mail date, qeDate).
  "electionDeadline" DATE NOT NULL,
  -- Up to 18 months of continuation coverage by default.
  "coverageEndsOn"   DATE NOT NULL,
  "noticedAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "electedAt"        TIMESTAMPTZ(6),
  "premiumPerMonth"  DECIMAL(10, 2),
  "status"           "CobraStatus" NOT NULL DEFAULT 'NOTIFIED',
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "CobraOffer_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE
);
CREATE INDEX "CobraOffer_associateId_idx" ON "CobraOffer" ("associateId");
CREATE INDEX "CobraOffer_status_idx" ON "CobraOffer" ("status");

-- ACA 1095-C reporting: per-associate, per-month indicator codes.
-- One row per (associate, year, month).
CREATE TABLE "AcaMonth" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"      UUID NOT NULL,
  "year"             INTEGER NOT NULL,
  "month"            INTEGER NOT NULL, -- 1-12
  "offerOfCoverage"  "AcaCoverageOffer",
  -- Lowest-cost monthly premium for self-only coverage, in cents.
  "lowestPremiumCents" INTEGER,
  -- Safe harbor code (Section 4980H): '2A','2B','2C','2D','2E','2F','2G','2H'.
  "safeHarbor"       VARCHAR(3),
  "isFullTime"       BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AcaMonth_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "AcaMonth_month_check" CHECK ("month" BETWEEN 1 AND 12),
  CONSTRAINT "AcaMonth_year_check" CHECK ("year" BETWEEN 2014 AND 2100)
);
CREATE UNIQUE INDEX "AcaMonth_unique"
  ON "AcaMonth" ("associateId", "year", "month");
CREATE INDEX "AcaMonth_year_idx" ON "AcaMonth" ("year");
