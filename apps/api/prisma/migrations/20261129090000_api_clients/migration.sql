-- Brief 2-4 step 1 — OAuth client-credentials clients for the public /v1 API.
-- Additive: one table and one nullable AuditLog column (the append-only trigger
-- guards rows, not columns).

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "apiClientId" UUID;

-- CreateTable
CREATE TABLE "ApiClient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" VARCHAR(40) NOT NULL,
    "secretHash" TEXT NOT NULL,
    "previousSecretHash" TEXT,
    "previousValidUntil" TIMESTAMPTZ(6),
    "name" VARCHAR(120) NOT NULL,
    "scopes" TEXT[],
    "ownerUserId" UUID NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_clientId_key" ON "ApiClient"("clientId");

-- CreateIndex
CREATE INDEX "ApiClient_tenantId_status_idx" ON "ApiClient"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_status_check" CHECK ("status" IN ('ACTIVE', 'REVOKED'));
