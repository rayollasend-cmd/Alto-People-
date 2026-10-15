-- Agent families step 5 — coverage.credentials
-- (docs/agent-families-investigation.md §4). Additive: what a site or client
-- requires, and the weekly coverage the Compliance agent measures against it.

-- CreateTable
CREATE TABLE "CredentialRequirement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "locationId" UUID,
    "clientId" UUID,
    "kind" VARCHAR(20) NOT NULL,
    "vaccinationKind" "VaccinationKind",
    "complianceTag" "ComplianceTag",
    "qualificationId" UUID,
    "label" VARCHAR(120) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,

    CONSTRAINT "CredentialRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialCoverageWeek" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requirementId" UUID NOT NULL,
    "weekOf" DATE NOT NULL,
    "population" INTEGER NOT NULL,
    "missing" INTEGER NOT NULL,
    "missingIds" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,

    CONSTRAINT "CredentialCoverageWeek_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CredentialRequirement_tenantId_deletedAt_idx" ON "CredentialRequirement"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "CredentialRequirement_locationId_idx" ON "CredentialRequirement"("locationId");

-- CreateIndex
CREATE INDEX "CredentialRequirement_clientId_idx" ON "CredentialRequirement"("clientId");

-- CreateIndex
CREATE INDEX "CredentialCoverageWeek_tenantId_weekOf_idx" ON "CredentialCoverageWeek"("tenantId", "weekOf");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialCoverageWeek_requirementId_weekOf_key" ON "CredentialCoverageWeek"("requirementId", "weekOf");

-- AddForeignKey
ALTER TABLE "CredentialRequirement" ADD CONSTRAINT "CredentialRequirement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialRequirement" ADD CONSTRAINT "CredentialRequirement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialRequirement" ADD CONSTRAINT "CredentialRequirement_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "Qualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialCoverageWeek" ADD CONSTRAINT "CredentialCoverageWeek_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "CredentialRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A requirement names a scope and exactly one target, by its kind.
ALTER TABLE "CredentialRequirement" ADD CONSTRAINT "CredentialRequirement_scope_check" CHECK ("locationId" IS NOT NULL OR "clientId" IS NOT NULL);
ALTER TABLE "CredentialRequirement" ADD CONSTRAINT "CredentialRequirement_target_check" CHECK (
  ("kind" = 'VACCINATION' AND "vaccinationKind" IS NOT NULL AND "complianceTag" IS NULL AND "qualificationId" IS NULL) OR
  ("kind" = 'TRAINING' AND "complianceTag" IS NOT NULL AND "vaccinationKind" IS NULL AND "qualificationId" IS NULL) OR
  ("kind" = 'QUALIFICATION' AND "qualificationId" IS NOT NULL AND "vaccinationKind" IS NULL AND "complianceTag" IS NULL)
);
ALTER TABLE "CredentialCoverageWeek" ADD CONSTRAINT "CredentialCoverageWeek_counts_check" CHECK ("population" >= 0 AND "missing" >= 0 AND "missing" <= "population");
