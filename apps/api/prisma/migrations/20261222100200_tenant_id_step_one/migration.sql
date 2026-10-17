-- The tables added in the October build carry tenantId the way every other
-- table does in step one of tenancy: nullable, defaulting to Alto HR.
ALTER TABLE "FloorFlag"               ALTER COLUMN "tenantId" DROP NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
ALTER TABLE "HrCaseSlaPolicy"         ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "PolicyCampaign"          ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "PolicyCampaignRecipient" ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "VerificationLetter"      ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "DocumentRetentionPolicy" ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "MassUpdateBatch"         ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "TenantSecurityPolicy"    ALTER COLUMN "tenantId" DROP NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
