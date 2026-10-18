-- TAXCOMP: WOTC screening, ACA look-back measurement, and the state
-- withholding acknowledgments + state withholding certificates.

ALTER TYPE "TaskKind" ADD VALUE IF NOT EXISTS 'WOTC_SCREENING';

-- ===== ACA =====
CREATE TYPE "AcaClassification" AS ENUM ('FULL_TIME', 'VARIABLE_HOUR', 'SEASONAL', 'PART_TIME');
CREATE TYPE "AcaOfferResponse" AS ENUM ('PENDING', 'ENROLLED', 'WAIVED');

CREATE TABLE "AcaSettings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "measurementMonths" INTEGER NOT NULL DEFAULT 12,
  "adminDays" INTEGER NOT NULL DEFAULT 60,
  "stabilityMonths" INTEGER NOT NULL DEFAULT 12,
  "initialMeasurementMonths" INTEGER NOT NULL DEFAULT 12,
  "stabilityStartMonth" INTEGER NOT NULL DEFAULT 1,
  "stabilityStartDay" INTEGER NOT NULL DEFAULT 1,
  "fullTimeHoursPerMonth" DECIMAL(6,2) NOT NULL DEFAULT 130,
  "breakInServiceWeeks" INTEGER NOT NULL DEFAULT 13,
  "ruleOfParity" BOOLEAN NOT NULL DEFAULT true,
  "defaultOfferCode" "AcaCoverageOffer" NOT NULL DEFAULT 'CODE_1E',
  "affordabilitySafeHarbor" VARCHAR(3) DEFAULT '2H',
  "lowestPremiumCents" INTEGER,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AcaSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcaSettings_tenantId_key" ON "AcaSettings"("tenantId");

CREATE TABLE "AcaWorkerClass" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "classification" "AcaClassification" NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "reason" VARCHAR(300),
  "setById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AcaWorkerClass_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AcaWorkerClass_associateId_effectiveFrom_idx" ON "AcaWorkerClass"("associateId", "effectiveFrom");
CREATE INDEX "AcaWorkerClass_tenantId_idx" ON "AcaWorkerClass"("tenantId");
ALTER TABLE "AcaWorkerClass" ADD CONSTRAINT "AcaWorkerClass_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AcaOffer" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "stabilityStart" DATE NOT NULL,
  "stabilityEnd" DATE NOT NULL,
  "offeredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "offeredById" UUID,
  "response" "AcaOfferResponse" NOT NULL DEFAULT 'PENDING',
  "respondedAt" TIMESTAMPTZ(6),
  "offerCode" "AcaCoverageOffer" NOT NULL DEFAULT 'CODE_1E',
  "lowestPremiumCents" INTEGER,
  "note" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AcaOffer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcaOffer_associateId_stabilityStart_key" ON "AcaOffer"("associateId", "stabilityStart");
CREATE INDEX "AcaOffer_tenantId_idx" ON "AcaOffer"("tenantId");
ALTER TABLE "AcaOffer" ADD CONSTRAINT "AcaOffer_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== WOTC =====
CREATE TYPE "WotcStatus" AS ENUM ('NOT_STARTED', 'DECLINED', 'NOT_ELIGIBLE', 'LIKELY_ELIGIBLE', 'SUBMITTED', 'CERTIFIED', 'DENIED');

CREATE TABLE "WotcSettings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "WotcSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WotcSettings_tenantId_key" ON "WotcSettings"("tenantId");

CREATE TABLE "WotcScreening" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "applicationId" UUID,
  "status" "WotcStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "answers" JSONB,
  "targetGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "applicantSignedName" VARCHAR(200),
  "applicantSignedAt" TIMESTAMPTZ(6),
  "applicantIp" VARCHAR(64),
  "offerDate" DATE,
  "hireDate" DATE,
  "startDate" DATE,
  "startingWage" DECIMAL(10,2),
  "position" VARCHAR(120),
  "filingState" VARCHAR(2),
  "employerCompletedAt" TIMESTAMPTZ(6),
  "employerCompletedBy" UUID,
  "submittedAt" TIMESTAMPTZ(6),
  "submittedBy" UUID,
  "submissionRef" VARCHAR(120),
  "certifiedAt" TIMESTAMPTZ(6),
  "certifiedGroup" VARCHAR(40),
  "deniedAt" TIMESTAMPTZ(6),
  "denialReason" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "WotcScreening_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WotcScreening_applicationId_key" ON "WotcScreening"("applicationId");
CREATE INDEX "WotcScreening_tenantId_status_idx" ON "WotcScreening"("tenantId", "status");
CREATE INDEX "WotcScreening_associateId_idx" ON "WotcScreening"("associateId");
ALTER TABLE "WotcScreening" ADD CONSTRAINT "WotcScreening_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WotcDesignatedZip" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "zip" VARCHAR(5) NOT NULL,
  "kind" VARCHAR(4) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WotcDesignatedZip_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WotcDesignatedZip_tenantId_zip_key" ON "WotcDesignatedZip"("tenantId", "zip");

-- ===== State withholding =====
CREATE TABLE "StateTaxAcknowledgment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "state" VARCHAR(2) NOT NULL,
  "taxYear" INTEGER NOT NULL,
  "acknowledgedById" UUID,
  "acknowledgedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" VARCHAR(500),
  CONSTRAINT "StateTaxAcknowledgment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StateTaxAcknowledgment_tenantId_state_taxYear_key" ON "StateTaxAcknowledgment"("tenantId", "state", "taxYear");

CREATE TABLE "AssociateStateW4" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "state" VARCHAR(2) NOT NULL,
  "filingStatus" VARCHAR(24) NOT NULL DEFAULT 'SINGLE',
  "allowances" INTEGER NOT NULL DEFAULT 0,
  "dependents" INTEGER NOT NULL DEFAULT 0,
  "additionalWithholding" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "exempt" BOOLEAN NOT NULL DEFAULT false,
  "county" VARCHAR(40),
  "signedAt" TIMESTAMPTZ(6),
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AssociateStateW4_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssociateStateW4_associateId_state_key" ON "AssociateStateW4"("associateId", "state");
CREATE INDEX "AssociateStateW4_tenantId_idx" ON "AssociateStateW4"("tenantId");
ALTER TABLE "AssociateStateW4" ADD CONSTRAINT "AssociateStateW4_associateId_fkey"
  FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
