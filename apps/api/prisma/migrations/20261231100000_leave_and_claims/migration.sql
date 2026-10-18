-- Leave of absence (FMLA, state paid leave, USERRA, ADA, personal/company),
-- unemployment claims (with offers of suitable work) and workers' comp
-- claims (FROI, modified duty). Medical documents live on LeaveDocument and
-- are read only by leave admins; every read is audited by the route.

CREATE TYPE "LeaveType" AS ENUM ('FMLA', 'STATE_PFML', 'MILITARY_USERRA', 'ADA_ACCOMMODATION', 'PERSONAL', 'COMPANY');
CREATE TYPE "LeaveReason" AS ENUM ('OWN_HEALTH', 'FAMILY_CARE', 'BONDING', 'PREGNANCY', 'MILITARY_EXIGENCY', 'MILITARY_CAREGIVER', 'MILITARY_SERVICE', 'ACCOMMODATION', 'OTHER');
CREATE TYPE "LeaveSchedule" AS ENUM ('CONTINUOUS', 'INTERMITTENT', 'REDUCED');
CREATE TYPE "LeaveStatus" AS ENUM ('REQUESTED', 'PENDING_CERTIFICATION', 'APPROVED', 'DENIED', 'RETURNED', 'CLOSED', 'CANCELLED');
CREATE TYPE "LeaveDocumentKind" AS ENUM ('MEDICAL_CERTIFICATION', 'FITNESS_FOR_DUTY', 'MILITARY_ORDERS', 'OTHER');
CREATE TYPE "FmlaYearMethod" AS ENUM ('ROLLING_BACKWARD', 'ROLLING_FORWARD', 'CALENDAR', 'FIXED');

CREATE TYPE "UnemploymentClaimStatus" AS ENUM ('NEW', 'RESPONDED', 'DETERMINED', 'HEARING_SCHEDULED', 'APPEALED', 'CLOSED');
CREATE TYPE "UnemploymentDecision" AS ENUM ('CONTEST', 'DO_NOT_CONTEST');
CREATE TYPE "UnemploymentDetermination" AS ENUM ('ALLOWED', 'DENIED');
CREATE TYPE "WorkOfferResponse" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'NO_RESPONSE');

CREATE TYPE "WcClaimStatus" AS ENUM ('OPEN', 'SUBMITTED', 'ACCEPTED', 'DENIED', 'CLOSED');
CREATE TYPE "WcClaimType" AS ENUM ('MEDICAL_ONLY', 'INDEMNITY');

CREATE TABLE "LeaveSettings" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"           UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "fmlaYearMethod"     "FmlaYearMethod" NOT NULL DEFAULT 'ROLLING_BACKWARD',
  "fmlaFixedYearStart" VARCHAR(5),
  "fmlaCoveredEmployer" BOOLEAN NOT NULL DEFAULT true,
  "worksiteAttestation" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "suiImpactFactor"    DECIMAL(6,3) NOT NULL DEFAULT 1.000,
  "uiResponseDays"     INTEGER NOT NULL DEFAULT 10,
  "froiDeadlineDays"   JSONB NOT NULL DEFAULT '{}'::jsonb,
  "updatedById"        UUID,
  "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "LeaveSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeaveSettings_tenantId_key" ON "LeaveSettings"("tenantId");

CREATE TABLE "LeaveCase" (
  "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"                 UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"              UUID NOT NULL,
  "type"                     "LeaveType" NOT NULL,
  "reason"                   "LeaveReason" NOT NULL,
  "stateProgram"             VARCHAR(20),
  "schedule"                 "LeaveSchedule" NOT NULL DEFAULT 'CONTINUOUS',
  "startDate"                DATE NOT NULL,
  "endDate"                  DATE,
  "intermittentPattern"      VARCHAR(300),
  "reducedHoursPerWeek"      DECIMAL(5,2),
  "status"                   "LeaveStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedById"            UUID,
  "requestedBySelf"          BOOLEAN NOT NULL DEFAULT false,
  "eligibility"              JSONB,
  "noticeSentAt"             TIMESTAMPTZ(6),
  "designationSentAt"        TIMESTAMPTZ(6),
  "designatedFmla"           BOOLEAN,
  "certificationDueAt"       DATE,
  "certificationReceivedAt"  TIMESTAMPTZ(6),
  "decidedById"              UUID,
  "decidedAt"                TIMESTAMPTZ(6),
  "decisionNote"             VARCHAR(2000),
  "fitnessForDutyRequired"   BOOLEAN NOT NULL DEFAULT false,
  "fitnessForDutyReceivedAt" TIMESTAMPTZ(6),
  "expectedReturnDate"       DATE,
  "actualReturnDate"         DATE,
  "benefitsNote"             VARCHAR(1000),
  "shiftsReleased"           INTEGER NOT NULL DEFAULT 0,
  "notes"                    VARCHAR(4000),
  "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "LeaveCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeaveCase_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LeaveCase_tenantId_status_idx" ON "LeaveCase"("tenantId", "status");
CREATE INDEX "LeaveCase_associateId_startDate_idx" ON "LeaveCase"("associateId", "startDate");

CREATE TABLE "LeaveUsage" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "leaveCaseId" UUID NOT NULL,
  "date"        DATE NOT NULL,
  "hours"       DECIMAL(5,2) NOT NULL,
  "shiftId"     UUID,
  "note"        VARCHAR(500),
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "LeaveUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeaveUsage_leaveCaseId_fkey" FOREIGN KEY ("leaveCaseId") REFERENCES "LeaveCase"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LeaveUsage_leaveCaseId_date_idx" ON "LeaveUsage"("leaveCaseId", "date");
CREATE INDEX "LeaveUsage_tenantId_idx" ON "LeaveUsage"("tenantId");

CREATE TABLE "LeaveDocument" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "leaveCaseId"  UUID NOT NULL,
  "kind"         "LeaveDocumentKind" NOT NULL,
  "storageKey"   VARCHAR(300) NOT NULL,
  "filename"     VARCHAR(255) NOT NULL,
  "mimeType"     VARCHAR(100) NOT NULL,
  "size"         INTEGER NOT NULL,
  "uploadedById" UUID,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "LeaveDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeaveDocument_leaveCaseId_fkey" FOREIGN KEY ("leaveCaseId") REFERENCES "LeaveCase"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LeaveDocument_leaveCaseId_idx" ON "LeaveDocument"("leaveCaseId");
CREATE INDEX "LeaveDocument_tenantId_idx" ON "LeaveDocument"("tenantId");

CREATE TABLE "UnemploymentClaim" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"          UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"       UUID NOT NULL,
  "separationId"      UUID,
  "clientId"          UUID,
  "state"             VARCHAR(2) NOT NULL,
  "claimDate"         DATE NOT NULL,
  "noticeReceivedAt"  DATE NOT NULL,
  "responseDueAt"     DATE NOT NULL,
  "stateClaimNumber"  VARCHAR(60),
  "status"            "UnemploymentClaimStatus" NOT NULL DEFAULT 'NEW',
  "decision"          "UnemploymentDecision",
  "decisionReason"    VARCHAR(2000),
  "respondedAt"       TIMESTAMPTZ(6),
  "respondedById"     UUID,
  "determination"     "UnemploymentDetermination",
  "determinationAt"   DATE,
  "chargesAmount"     DECIMAL(12,2),
  "hearingAt"         TIMESTAMPTZ(6),
  "hearingOutcome"    "UnemploymentDetermination",
  "appealFiledAt"     DATE,
  "appealOutcome"     "UnemploymentDetermination",
  "notes"             VARCHAR(4000),
  "createdById"       UUID,
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "UnemploymentClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UnemploymentClaim_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UnemploymentClaim_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "UnemploymentClaim_tenantId_status_idx" ON "UnemploymentClaim"("tenantId", "status");
CREATE INDEX "UnemploymentClaim_responseDueAt_idx" ON "UnemploymentClaim"("responseDueAt");
CREATE INDEX "UnemploymentClaim_associateId_idx" ON "UnemploymentClaim"("associateId");

CREATE TABLE "WorkOffer" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"   UUID NOT NULL,
  "claimId"       UUID,
  "offeredAt"     TIMESTAMPTZ(6) NOT NULL,
  "offeredById"   UUID,
  "description"   VARCHAR(1000) NOT NULL,
  "clientId"      UUID,
  "locationId"    UUID,
  "payRate"       DECIMAL(8,2),
  "response"      "WorkOfferResponse" NOT NULL DEFAULT 'PENDING',
  "respondedAt"   TIMESTAMPTZ(6),
  "declineReason" VARCHAR(1000),
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "WorkOffer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkOffer_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkOffer_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "UnemploymentClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "WorkOffer_associateId_offeredAt_idx" ON "WorkOffer"("associateId", "offeredAt");
CREATE INDEX "WorkOffer_tenantId_idx" ON "WorkOffer"("tenantId");

CREATE TABLE "WcClaim" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"              UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "oshaIncidentId"        UUID,
  "associateId"           UUID NOT NULL,
  "clientId"              UUID,
  "locationId"            UUID,
  "jurisdiction"          VARCHAR(2) NOT NULL,
  "injuryDate"            TIMESTAMPTZ(6) NOT NULL,
  "reportedToEmployerAt"  DATE NOT NULL,
  "froiDueAt"             DATE NOT NULL,
  "froi"                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  "froiSubmittedAt"       TIMESTAMPTZ(6),
  "submittedById"         UUID,
  "carrierName"           VARCHAR(160),
  "carrierClaimNumber"    VARCHAR(80),
  "status"                "WcClaimStatus" NOT NULL DEFAULT 'OPEN',
  "claimType"             "WcClaimType" NOT NULL DEFAULT 'MEDICAL_ONLY',
  "lostTimeDays"          INTEGER NOT NULL DEFAULT 0,
  "restrictedDays"        INTEGER NOT NULL DEFAULT 0,
  "reserveMedical"        DECIMAL(12,2),
  "reserveIndemnity"      DECIMAL(12,2),
  "restrictions"          VARCHAR(2000),
  "rtwDate"               DATE,
  "notes"                 VARCHAR(4000),
  "createdById"           UUID,
  "createdAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "WcClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WcClaim_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WcClaim_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WcClaim_oshaIncidentId_key" ON "WcClaim"("oshaIncidentId");
CREATE INDEX "WcClaim_tenantId_status_idx" ON "WcClaim"("tenantId", "status");
CREATE INDEX "WcClaim_froiDueAt_idx" ON "WcClaim"("froiDueAt");

CREATE TABLE "WcModifiedDutyOffer" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "wcClaimId"    UUID NOT NULL,
  "offeredAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "offeredById"  UUID,
  "shiftId"      UUID,
  "description"  VARCHAR(1000) NOT NULL,
  "response"     "WorkOfferResponse" NOT NULL DEFAULT 'PENDING',
  "respondedAt"  TIMESTAMPTZ(6),
  CONSTRAINT "WcModifiedDutyOffer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WcModifiedDutyOffer_wcClaimId_fkey" FOREIGN KEY ("wcClaimId") REFERENCES "WcClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WcModifiedDutyOffer_wcClaimId_idx" ON "WcModifiedDutyOffer"("wcClaimId");
CREATE INDEX "WcModifiedDutyOffer_tenantId_idx" ON "WcModifiedDutyOffer"("tenantId");
