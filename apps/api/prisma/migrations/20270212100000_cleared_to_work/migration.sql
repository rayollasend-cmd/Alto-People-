-- Cleared to work (owner, 2026-11-03): a site or client may require a
-- background check or a drug test, with a maximum age for the latest passed
-- one (365 = a yearly re-screen, 60 = a drug test every 60 days). Null means
-- any passed check counts. A new nullable column and a widened check: no
-- existing row changes, and nothing is required until HR sets a requirement.
ALTER TABLE "CredentialRequirement" ADD COLUMN IF NOT EXISTS "maxAgeDays" INTEGER;

-- The target rule gains the two screening kinds, which name no target.
ALTER TABLE "CredentialRequirement" DROP CONSTRAINT IF EXISTS "CredentialRequirement_target_check";
ALTER TABLE "CredentialRequirement" ADD CONSTRAINT "CredentialRequirement_target_check" CHECK (
  ("kind" = 'VACCINATION' AND "vaccinationKind" IS NOT NULL AND "complianceTag" IS NULL AND "qualificationId" IS NULL) OR
  ("kind" = 'TRAINING' AND "complianceTag" IS NOT NULL AND "vaccinationKind" IS NULL AND "qualificationId" IS NULL) OR
  ("kind" = 'QUALIFICATION' AND "qualificationId" IS NOT NULL AND "vaccinationKind" IS NULL AND "complianceTag" IS NULL) OR
  ("kind" IN ('BACKGROUND_CHECK', 'DRUG_TEST') AND "vaccinationKind" IS NULL AND "complianceTag" IS NULL AND "qualificationId" IS NULL)
);

-- A maximum age belongs to a screening, and is at least a day.
ALTER TABLE "CredentialRequirement" DROP CONSTRAINT IF EXISTS "CredentialRequirement_max_age_check";
ALTER TABLE "CredentialRequirement" ADD CONSTRAINT "CredentialRequirement_max_age_check" CHECK (
  "maxAgeDays" IS NULL OR ("kind" IN ('BACKGROUND_CHECK', 'DRUG_TEST') AND "maxAgeDays" >= 1)
);

-- Company-wide requirements (owner, 2026-11-03: every client requires a
-- background check and a drug test). A requirement that names neither a
-- site nor a client applies to everyone in the workforce, so the rule that
-- one of the two must be set goes.
ALTER TABLE "CredentialRequirement" DROP CONSTRAINT IF EXISTS "CredentialRequirement_scope_check";

-- The owner's standing answer, for Alto HR only: a passed background check
-- and a passed drug test, any age (pre-employment screening; HR may set a
-- re-screen age later on the Requirements tab). Inserted only when the
-- tenant exists and no live company-wide requirement of that kind does, so
-- it never doubles and never touches another tenant.
INSERT INTO "CredentialRequirement" ("tenantId", "kind", "label", "maxAgeDays")
SELECT t."id", k."kind", k."label", NULL
FROM "Tenant" t
CROSS JOIN (VALUES ('BACKGROUND_CHECK', 'Background check'), ('DRUG_TEST', 'Drug test')) AS k("kind", "label")
WHERE t."id" = '00000000-0000-4000-8000-000000000001'::uuid
  AND NOT EXISTS (
    SELECT 1 FROM "CredentialRequirement" r
    WHERE r."tenantId" = t."id" AND r."kind" = k."kind" AND r."locationId" IS NULL AND r."clientId" IS NULL AND r."deletedAt" IS NULL
  );
