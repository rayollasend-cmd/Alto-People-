-- Brief 2-3 step 2 — identity per tenant: a tenant's own IdP connections, its verified
-- email domains, each person's IdP subject binding, and per-tenant SCIM tokens.
-- Additive. The environment IdP and SCIM_TOKEN become Alto HR's first rows at boot
-- (they live in the environment, not in SQL).

-- CreateTable
CREATE TABLE "IdentityConnection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "kind" VARCHAR(10) NOT NULL DEFAULT 'OIDC',
    "displayName" VARCHAR(120) NOT NULL,
    "buttonLabel" VARCHAR(80),
    "issuerUrl" VARCHAR(500) NOT NULL,
    "clientId" VARCHAR(300) NOT NULL,
    "clientSecretEnc" BYTEA NOT NULL,
    "jitPolicy" VARCHAR(20) NOT NULL DEFAULT 'INVITED_ONLY',
    "ssoRequiredForStaff" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fromEnvironment" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "IdentityConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantDomain" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "domain" VARCHAR(253) NOT NULL,
    "verificationToken" VARCHAR(80) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(6),
    "lastCheckedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserIdentity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "userId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "emailAtLink" VARCHAR(254) NOT NULL,
    "linkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMPTZ(6),

    CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScimToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "name" VARCHAR(120) NOT NULL,
    "hashedSecret" VARCHAR(64) NOT NULL,
    "last4" VARCHAR(4) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ScimToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdentityConnection_tenantId_enabled_idx" ON "IdentityConnection"("tenantId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "TenantDomain_domain_key" ON "TenantDomain"("domain");

-- CreateIndex
CREATE INDEX "TenantDomain_tenantId_idx" ON "TenantDomain"("tenantId");

-- CreateIndex
CREATE INDEX "UserIdentity_tenantId_idx" ON "UserIdentity"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentity_connectionId_subject_key" ON "UserIdentity"("connectionId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentity_userId_connectionId_key" ON "UserIdentity"("userId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ScimToken_hashedSecret_key" ON "ScimToken"("hashedSecret");

-- CreateIndex
CREATE INDEX "ScimToken_tenantId_idx" ON "ScimToken"("tenantId");

-- AddForeignKey
ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IdentityConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IdentityConnection" ADD CONSTRAINT "IdentityConnection_kind_check" CHECK ("kind" IN ('OIDC', 'SAML'));
ALTER TABLE "IdentityConnection" ADD CONSTRAINT "IdentityConnection_jit_check" CHECK ("jitPolicy" IN ('NONE', 'INVITED_ONLY'));
-- A domain is stored lower-case, without a scheme or path.
ALTER TABLE "TenantDomain" ADD CONSTRAINT "TenantDomain_domain_check" CHECK ("domain" = lower("domain") AND "domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');
