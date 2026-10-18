-- Pay and bill-rate intelligence, and standards-based credentials.

-- Public wage data (BLS OEWS) by metro area and occupation. Reference data
-- shared by every tenant: no tenantId, like GeoCache.
CREATE TABLE "MarketWage" (
  "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
  "areaCode"    VARCHAR(7)    NOT NULL,
  "areaName"    VARCHAR(160)  NOT NULL,
  "socCode"     VARCHAR(7)    NOT NULL,
  "socTitle"    VARCHAR(200)  NOT NULL,
  "year"        INTEGER       NOT NULL,
  "p10"         DECIMAL(8,2),
  "p25"         DECIMAL(8,2),
  "median"      DECIMAL(8,2),
  "p75"         DECIMAL(8,2),
  "p90"         DECIMAL(8,2),
  "mean"        DECIMAL(8,2),
  "employment"  INTEGER,
  "source"      VARCHAR(20)   NOT NULL DEFAULT 'BLS_OEWS',
  "fetchedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "MarketWage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketWage_areaCode_socCode_year_key" ON "MarketWage"("areaCode", "socCode", "year");
CREATE INDEX "MarketWage_socCode_idx" ON "MarketWage"("socCode");

-- Each store's metro area (CBSA), set by an admin from a suggestion.
ALTER TABLE "Location"
  ADD COLUMN "marketAreaCode" VARCHAR(7),
  ADD COLUMN "marketAreaName" VARCHAR(160);

-- A role name (rate-card position, shift position, job profile) → SOC code.
CREATE TABLE "PositionSocMap" (
  "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID          DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "positionKey" VARCHAR(120)  NOT NULL,
  "position"    VARCHAR(120)  NOT NULL,
  "socCode"     VARCHAR(7)    NOT NULL,
  "socTitle"    VARCHAR(200)  NOT NULL,
  "updatedById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PositionSocMap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PositionSocMap_tenantId_positionKey_key" ON "PositionSocMap"("tenantId", "positionKey");
CREATE INDEX "PositionSocMap_tenantId_idx" ON "PositionSocMap"("tenantId");

-- The margin a client's bill rates are priced to.
ALTER TABLE "Client" ADD COLUMN "targetMarginPct" DECIMAL(5,2);

-- Each tenant's credential-issuing key (Ed25519). The private key is
-- stored encrypted with the field keyring; the public key is published in
-- the tenant's DID document.
CREATE TABLE "CredentialIssuerKey" (
  "id"            UUID          NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID          DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "keyId"         VARCHAR(40)   NOT NULL DEFAULT 'key-1',
  "publicKey"     BYTEA         NOT NULL,
  "privateKeyEnc" BYTEA         NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "CredentialIssuerKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CredentialIssuerKey_tenantId_key" ON "CredentialIssuerKey"("tenantId");

-- Each issued credential's slot in the tenant's revocation list.
CREATE TABLE "CredentialStatusEntry" (
  "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID          DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "listIndex"   INTEGER       NOT NULL,
  "subjectType" VARCHAR(20)   NOT NULL,
  "subjectId"   UUID          NOT NULL,
  "associateId" UUID          NOT NULL,
  "revokedAt"   TIMESTAMPTZ(6),
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "CredentialStatusEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CredentialStatusEntry_subjectType_subjectId_key" ON "CredentialStatusEntry"("subjectType", "subjectId");
CREATE UNIQUE INDEX "CredentialStatusEntry_tenantId_listIndex_key" ON "CredentialStatusEntry"("tenantId", "listIndex");
CREATE INDEX "CredentialStatusEntry_associateId_idx" ON "CredentialStatusEntry"("associateId");
