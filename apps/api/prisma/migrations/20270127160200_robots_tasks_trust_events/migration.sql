-- Audit 2026-10-21, Tier 3 (robots, tasks, trust center, product analytics).

-- Robots: the incident retention sweep marks evidence it removed past retainUntil.
ALTER TABLE "RobotIncident" ADD COLUMN "evidencePurgedAt" TIMESTAMPTZ(6);

-- Tasks: a site's policy row merges with the company's, field by field. A null means
-- "inherit", so the columns lose their NOT NULL and their defaults; existing rows keep
-- the values they were created with.
ALTER TABLE "WorkTaskPolicy"
  ALTER COLUMN "handoffSeconds" DROP NOT NULL,
  ALTER COLUMN "handoffSeconds" DROP DEFAULT,
  ALTER COLUMN "highRiskPolicy" DROP NOT NULL,
  ALTER COLUMN "highRiskPolicy" DROP DEFAULT,
  ALTER COLUMN "robotCostPerTaskCents" DROP NOT NULL,
  ALTER COLUMN "robotCostPerTaskCents" DROP DEFAULT,
  ALTER COLUMN "robotDefaultCostCents" DROP NOT NULL,
  ALTER COLUMN "robotDefaultCostCents" DROP DEFAULT,
  ALTER COLUMN "agentCostPerTaskCents" DROP NOT NULL,
  ALTER COLUMN "agentCostPerTaskCents" DROP DEFAULT,
  ALTER COLUMN "maxRobotsPerCrewLead" DROP NOT NULL,
  ALTER COLUMN "maxRobotsPerCrewLead" DROP DEFAULT,
  ALTER COLUMN "robotUtilizationPct" DROP NOT NULL,
  ALTER COLUMN "robotUtilizationPct" DROP DEFAULT,
  ALTER COLUMN "backupCrewRatioPct" DROP NOT NULL,
  ALTER COLUMN "backupCrewRatioPct" DROP DEFAULT;

-- Trust Center: the SOC 2 report date the operator sets, the gated documents and the requests.
ALTER TABLE "OrgSetting" ADD COLUMN "soc2ReportIssuedOn" DATE;

CREATE TYPE "TrustDocumentKind" AS ENUM ('SOC2_REPORT', 'PEN_TEST_SUMMARY', 'SUB_PROCESSOR_LIST', 'DPA');
CREATE TYPE "TrustRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

CREATE TABLE "TrustDocument" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "kind" "TrustDocumentKind" NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "s3Key" VARCHAR(400) NOT NULL,
  "contentType" VARCHAR(120) NOT NULL,
  "bytes" INTEGER NOT NULL,
  "uploadedByUserId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TrustDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TrustDocument_tenantId_kind_key" ON "TrustDocument"("tenantId", "kind");

CREATE TABLE "TrustDownloadRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "kind" "TrustDocumentKind" NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "company" VARCHAR(200) NOT NULL,
  "note" VARCHAR(1000),
  "status" "TrustRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMPTZ(6),
  "decidedByUserId" UUID,
  "linkExpiresAt" TIMESTAMPTZ(6),
  "downloadCount" INTEGER NOT NULL DEFAULT 0,
  "lastDownloadedAt" TIMESTAMPTZ(6),
  CONSTRAINT "TrustDownloadRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TrustDownloadRequest_tenantId_status_requestedAt_idx" ON "TrustDownloadRequest"("tenantId", "status", "requestedAt" DESC);
CREATE INDEX "TrustDownloadRequest_email_idx" ON "TrustDownloadRequest"("email");

-- Product analytics: the three behaviour events, rolled up per day, role and kind.
CREATE TABLE "ProductEventDaily" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "day" DATE NOT NULL,
  "role" VARCHAR(40) NOT NULL,
  "kind" VARCHAR(40) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "sum" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "ProductEventDaily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductEventDaily_day_role_kind_key" ON "ProductEventDaily"("day", "role", "kind");
CREATE INDEX "ProductEventDaily_day_idx" ON "ProductEventDaily"("day");
