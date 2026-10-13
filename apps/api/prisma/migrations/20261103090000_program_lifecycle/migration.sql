-- Brief 1C-2: the Program Lifecycle module. Additive: four new tables, no
-- change to existing ones. The existing J-1 profiles are copied into
-- Program rows (one J1_SWT program each) and their sponsor agencies become
-- Sponsor rows, so the module opens with the current cohort loaded. The
-- J1Profile table stays — the J-1 compliance tab still reads it, and the
-- upsert keeps both in step until that tab moves over.

CREATE TYPE "ProgramType" AS ENUM ('J1_SWT', 'H2B', 'DOMESTIC');
CREATE TYPE "SecondJobStatus" AS ENUM ('NOT_REQUESTED', 'REQUESTED', 'APPROVED', 'DENIED');

CREATE TABLE "Sponsor" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(160) NOT NULL,
    "programType" "ProgramType" NOT NULL DEFAULT 'J1_SWT',
    "contactName" VARCHAR(120),
    "contactEmail" VARCHAR(254),
    "contactPhone" VARCHAR(40),
    "website" VARCHAR(300),
    "checkInCadenceDays" INTEGER NOT NULL DEFAULT 30,
    "checkInRequirements" VARCHAR(2000),
    "reportingCadence" VARCHAR(500),
    "notes" VARCHAR(2000),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Sponsor_name_key" ON "Sponsor"("name");
CREATE INDEX "Sponsor_isActive_name_idx" ON "Sponsor"("isActive", "name");

CREATE TABLE "Program" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "type" "ProgramType" NOT NULL,
    "sponsorId" UUID,
    "ds2019Number" VARCHAR(80),
    "ds2019IssuedOn" DATE,
    "ds2019ExpiresOn" DATE,
    "visaExpiresOn" DATE,
    "sevisId" VARCHAR(80),
    "country" VARCHAR(80),
    "programStart" DATE NOT NULL,
    "programEnd" DATE NOT NULL,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 30,
    "secondJobStatus" "SecondJobStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "h2bPetitionNumber" VARCHAR(60),
    "petitionClientId" UUID,
    "petitionValidFrom" DATE,
    "petitionValidTo" DATE,
    "worksiteArea" VARCHAR(160),
    "lastSponsorCheckInOn" DATE,
    "notes" VARCHAR(2000),
    "closedAt" TIMESTAMPTZ(6),
    "closedReason" VARCHAR(300),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Program_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Program_associateId_programEnd_idx" ON "Program"("associateId", "programEnd" DESC);
CREATE INDEX "Program_type_programEnd_idx" ON "Program"("type", "programEnd");
CREATE INDEX "Program_sponsorId_idx" ON "Program"("sponsorId");
CREATE INDEX "Program_petitionClientId_idx" ON "Program"("petitionClientId");

ALTER TABLE "Program" ADD CONSTRAINT "Program_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Program" ADD CONSTRAINT "Program_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Program" ADD CONSTRAINT "Program_petitionClientId_fkey" FOREIGN KEY ("petitionClientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ProgramDocument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "programId" UUID NOT NULL,
    "documentId" UUID NOT NULL,

    CONSTRAINT "ProgramDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProgramDocument_programId_documentId_key" ON "ProgramDocument"("programId", "documentId");

ALTER TABLE "ProgramDocument" ADD CONSTRAINT "ProgramDocument_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgramDocument" ADD CONSTRAINT "ProgramDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocumentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProgramAlertSetting" (
    "id" VARCHAR(16) NOT NULL DEFAULT 'singleton',
    "programEndDays" INTEGER[] DEFAULT ARRAY[60, 30, 14, 7]::INTEGER[],
    "visaExpiryDays" INTEGER[] DEFAULT ARRAY[60, 30]::INTEGER[],
    "i9ReverifyDays" INTEGER[] DEFAULT ARRAY[90, 30, 7]::INTEGER[],
    "sponsorCheckInDays" INTEGER[] DEFAULT ARRAY[7, 0]::INTEGER[],
    "petitionEndDays" INTEGER[] DEFAULT ARRAY[60, 30]::INTEGER[],
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ProgramAlertSetting_pkey" PRIMARY KEY ("id")
);

-- Backfill: every sponsor agency named on a J-1 profile becomes a Sponsor;
-- every J-1 profile becomes a J1_SWT Program. Idempotent on re-run.
INSERT INTO "Sponsor" ("name", "programType", "updatedAt")
SELECT DISTINCT trim("sponsorAgency"), 'J1_SWT'::"ProgramType", CURRENT_TIMESTAMP
FROM "J1Profile"
WHERE trim(coalesce("sponsorAgency", '')) <> ''
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "Program" (
  "associateId", "type", "sponsorId", "ds2019Number", "sevisId", "country",
  "programStart", "programEnd", "gracePeriodDays", "updatedAt"
)
SELECT
  j."associateId", 'J1_SWT'::"ProgramType", s."id", j."ds2019Number", j."sevisId", j."country",
  j."programStartDate", j."programEndDate", 30, CURRENT_TIMESTAMP
FROM "J1Profile" j
LEFT JOIN "Sponsor" s ON s."name" = trim(j."sponsorAgency")
WHERE NOT EXISTS (
  SELECT 1 FROM "Program" p
  WHERE p."associateId" = j."associateId" AND p."type" = 'J1_SWT'::"ProgramType" AND p."programEnd" = j."programEndDate"
);
