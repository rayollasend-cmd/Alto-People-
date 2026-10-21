-- A photo at every punch, required where a rule says so: the company, a
-- client, a store, or one person (with a reason and an optional end date).
-- The most specific rule in force wins (lib/punchPhotoPolicy). A required
-- punch without a photo is refused at the kiosk — unless the camera isn't
-- working, when it's kept and flagged NO_PHOTO for a supervisor to confirm.

ALTER TYPE "KioskAnomalyKind" ADD VALUE 'NO_PHOTO';

CREATE TABLE "PunchPhotoRule" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "scope"       VARCHAR(10) NOT NULL,
  "clientId"    UUID,
  "siteId"      UUID,
  "associateId" UUID,
  "required"    BOOLEAN NOT NULL DEFAULT true,
  "reason"      VARCHAR(500),
  "startsOn"    DATE NOT NULL,
  "endsOn"      DATE,
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "endedAt"     TIMESTAMPTZ(6),
  "endedById"   UUID,
  "endReason"   VARCHAR(500),
  CONSTRAINT "PunchPhotoRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PunchPhotoRule_scope_check" CHECK ("scope" IN ('COMPANY', 'CLIENT', 'SITE', 'ASSOCIATE')),
  CONSTRAINT "PunchPhotoRule_target_check" CHECK (
    ("scope" = 'COMPANY'   AND "clientId" IS NULL AND "siteId" IS NULL AND "associateId" IS NULL) OR
    ("scope" = 'CLIENT'    AND "clientId" IS NOT NULL AND "siteId" IS NULL AND "associateId" IS NULL) OR
    ("scope" = 'SITE'      AND "siteId" IS NOT NULL AND "associateId" IS NULL) OR
    ("scope" = 'ASSOCIATE' AND "associateId" IS NOT NULL AND "siteId" IS NULL)
  ),
  CONSTRAINT "PunchPhotoRule_dates_check" CHECK ("endsOn" IS NULL OR "endsOn" >= "startsOn")
);
CREATE INDEX "PunchPhotoRule_tenantId_scope_idx" ON "PunchPhotoRule"("tenantId", "scope");
CREATE INDEX "PunchPhotoRule_associateId_idx" ON "PunchPhotoRule"("associateId");
CREATE INDEX "PunchPhotoRule_siteId_idx" ON "PunchPhotoRule"("siteId");
CREATE INDEX "PunchPhotoRule_clientId_idx" ON "PunchPhotoRule"("clientId");
