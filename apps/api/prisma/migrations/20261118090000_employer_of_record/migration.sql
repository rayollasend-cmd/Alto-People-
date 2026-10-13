-- Brief 2-1b, step 4: the employer of record. Additive; nothing on Client
-- changes. One EmployerOrganization per tenant (its own, the default), one
-- per client that carries legal facts today, and one Employment per
-- approved application — so every tax form resolves its employer from the
-- employment record from now on, with the same facts it read from the
-- client yesterday. The owner's decision 3.

DO $$ BEGIN
  CREATE TYPE "EmployerKind" AS ENUM ('TENANT', 'CLIENT', 'THIRD_PARTY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "EmployerOrganization" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "kind" "EmployerKind" NOT NULL,
  "legalName" VARCHAR(255) NOT NULL,
  "ein" VARCHAR(20),
  "addressLine1" VARCHAR(255),
  "addressLine2" VARCHAR(255),
  "city" VARCHAR(120),
  "state" VARCHAR(2),
  "zip" VARCHAR(10),
  "sutaRateOverride" DECIMAL(6,5),
  "sutaWageBaseOverride" DECIMAL(12,2),
  "clientId" UUID,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployerOrganization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "EmployerOrganization_clientId_key" ON "EmployerOrganization"("clientId");
CREATE INDEX IF NOT EXISTS "EmployerOrganization_tenantId_isDefault_idx" ON "EmployerOrganization"("tenantId", "isDefault");
DO $$ BEGIN
  ALTER TABLE "EmployerOrganization" ADD CONSTRAINT "EmployerOrganization_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Employment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "employerOrgId" UUID NOT NULL,
  "employmentType" "EmploymentType" NOT NULL DEFAULT 'W2_EMPLOYEE',
  "hireDate" DATE NOT NULL,
  "endDate" DATE,
  "applicationId" UUID,
  "siteId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Employment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Employment_applicationId_key" ON "Employment"("applicationId");
CREATE INDEX IF NOT EXISTS "Employment_associateId_endDate_idx" ON "Employment"("associateId", "endDate");
CREATE INDEX IF NOT EXISTS "Employment_employerOrgId_idx" ON "Employment"("employerOrgId");
CREATE INDEX IF NOT EXISTS "Employment_tenantId_idx" ON "Employment"("tenantId");
DO $$ BEGIN
  ALTER TABLE "Employment" ADD CONSTRAINT "Employment_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Employment" ADD CONSTRAINT "Employment_employerOrgId_fkey"
    FOREIGN KEY ("employerOrgId") REFERENCES "EmployerOrganization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Employment" ADD CONSTRAINT "Employment_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Employment" ADD CONSTRAINT "Employment_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The tenant's own employer row (the default), from the submitter profile
-- when one exists, else the organization name.
INSERT INTO "EmployerOrganization" ("tenantId", "kind", "legalName", "ein", "addressLine1", "addressLine2", "city", "state", "zip", "isDefault")
SELECT t."id", 'TENANT',
       COALESCE(sp."name", (SELECT "orgName" FROM "OrgSetting" LIMIT 1), 'Alto Etho LLC'),
       sp."ein", sp."addressLine1", sp."addressLine2", sp."city", sp."state", sp."zip5", true
FROM "Tenant" t
LEFT JOIN "SubmitterProfile" sp ON sp."id" = 'singleton'
WHERE NOT EXISTS (SELECT 1 FROM "EmployerOrganization" e WHERE e."tenantId" = t."id" AND e."isDefault");

-- A client that carries legal facts today is an employer of record of its
-- own, with the same facts; the client row keeps them for its other uses.
INSERT INTO "EmployerOrganization" ("tenantId", "kind", "legalName", "ein", "addressLine1", "addressLine2", "city", "state", "zip", "sutaRateOverride", "sutaWageBaseOverride", "clientId", "isDefault")
SELECT COALESCE(c."tenantId", '00000000-0000-4000-8000-000000000001'::uuid), 'CLIENT',
       COALESCE(c."legalName", c."name"), c."ein", c."addressLine1", c."addressLine2", c."city", c."state", c."zip",
       c."sutaRateOverride", c."sutaWageBaseOverride", c."id", false
FROM "Client" c
WHERE c."deletedAt" IS NULL
  AND (c."legalName" IS NOT NULL OR c."ein" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "EmployerOrganization" e WHERE e."clientId" = c."id");

-- One employment spell per approved application: the hire date from the
-- associate, the end from the separation, the employer the client's row
-- when it has one, else the tenant's default.
INSERT INTO "Employment" ("tenantId", "associateId", "employerOrgId", "employmentType", "hireDate", "endDate", "applicationId", "siteId")
SELECT COALESCE(a."tenantId", '00000000-0000-4000-8000-000000000001'::uuid),
       a."associateId",
       COALESCE(eo."id", def."id"),
       asso."employmentType",
       COALESCE(asso."hireDate", a."approvedAt"::date, a."createdAt"::date),
       asso."separatedAt"::date,
       a."id",
       a."locationId"
FROM "Application" a
JOIN "Associate" asso ON asso."id" = a."associateId"
LEFT JOIN "EmployerOrganization" eo ON eo."clientId" = a."clientId"
JOIN "EmployerOrganization" def ON def."isDefault" AND def."tenantId" = COALESCE(a."tenantId", '00000000-0000-4000-8000-000000000001'::uuid)
WHERE a."status" = 'APPROVED'
  AND a."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Employment" em WHERE em."applicationId" = a."id");
