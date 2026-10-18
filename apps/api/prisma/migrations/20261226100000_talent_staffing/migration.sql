-- Talent pages shaped like a staffing company (client → store → shift → crew).

-- Career ladders: what a rung asks for beyond skills — certifications, time
-- in the job, and the last review.
ALTER TABLE "CareerLevel"
  ADD COLUMN "requiredQualificationCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "minTenureMonths" INTEGER,
  ADD COLUMN "minReviewRating" INTEGER;

-- Goals cascade: a company or team goal belongs to no one person.
ALTER TABLE "Goal" ALTER COLUMN "associateId" DROP NOT NULL;
ALTER TABLE "Goal"
  ADD COLUMN "scope" VARCHAR(16) NOT NULL DEFAULT 'PERSON',
  ADD COLUMN "ownerUserId" UUID;
ALTER TABLE "Goal"
  ADD CONSTRAINT "Goal_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Goal_scope_idx" ON "Goal"("scope");

-- 30/60/90 plans: a seasonal template beside the standard one.
ALTER TABLE "RampPlan" ADD COLUMN "template" VARCHAR(20) NOT NULL DEFAULT 'STANDARD';

-- Assets live at a store; field kit is its own kind.
ALTER TYPE "AssetKind" ADD VALUE IF NOT EXISTS 'PPE';
ALTER TYPE "AssetKind" ADD VALUE IF NOT EXISTS 'DEVICE';
ALTER TABLE "Asset" ADD COLUMN "locationId" UUID;
ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Asset_locationId_idx" ON "Asset"("locationId");

-- Succession for the seats that run a store: who could lead it next.
CREATE TYPE "BenchReadiness" AS ENUM ('READY_NOW', 'READY_6_MONTHS', 'READY_12_MONTHS');
CREATE TABLE "LeadBenchCandidate" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "locationId"  UUID NOT NULL,
  "associateId" UUID NOT NULL,
  "readiness"   "BenchReadiness" NOT NULL,
  "notes"       VARCHAR(1000),
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "LeadBenchCandidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeadBenchCandidate_locationId_associateId_key" ON "LeadBenchCandidate"("locationId", "associateId");
CREATE INDEX "LeadBenchCandidate_associateId_idx" ON "LeadBenchCandidate"("associateId");
CREATE INDEX "LeadBenchCandidate_tenantId_idx" ON "LeadBenchCandidate"("tenantId");
ALTER TABLE "LeadBenchCandidate"
  ADD CONSTRAINT "LeadBenchCandidate_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "LeadBenchCandidate_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "LeadBenchCandidate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The 9-box's other axis: potential, rated by HR (performance comes from reviews).
CREATE TABLE "TalentRating" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "potential"   INTEGER NOT NULL,
  "notes"       VARCHAR(1000),
  "ratedById"   UUID,
  "ratedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "TalentRating_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TalentRating_associateId_key" ON "TalentRating"("associateId");
CREATE INDEX "TalentRating_tenantId_idx" ON "TalentRating"("tenantId");
ALTER TABLE "TalentRating"
  ADD CONSTRAINT "TalentRating_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TalentRating_ratedById_fkey" FOREIGN KEY ("ratedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
