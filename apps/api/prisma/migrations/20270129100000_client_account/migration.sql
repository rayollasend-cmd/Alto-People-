-- The client's page runs the account (CL-A, 2026-10-22).
--
-- Client gains who owns the account (an internal user; SET NULL when that
-- user goes) and the contract's term (calendar days). New ClientContact:
-- the people at the client we deal with, one primary per client (partial
-- unique index; the API moves the flag), soft-deleted, tenant-keyed and
-- under the database wall like every other tenant table.
-- Additive only: no existing row is rewritten.

ALTER TABLE "Client" ADD COLUMN "accountOwnerUserId" UUID;
ALTER TABLE "Client" ADD COLUMN "contractStartDate" DATE;
ALTER TABLE "Client" ADD COLUMN "contractEndDate" DATE;
ALTER TABLE "Client" ADD CONSTRAINT "Client_accountOwnerUserId_fkey" FOREIGN KEY ("accountOwnerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Client_accountOwnerUserId_idx" ON "Client"("accountOwnerUserId");

CREATE TYPE "ClientContactRole" AS ENUM ('PRIMARY', 'BILLING', 'SITE', 'OPERATIONS', 'OTHER');

CREATE TABLE "ClientContact" (
  "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"  UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "clientId"  UUID NOT NULL,
  "name"      VARCHAR(120) NOT NULL,
  "title"     VARCHAR(120),
  "email"     VARCHAR(254),
  "phone"     VARCHAR(40),
  "role"      "ClientContactRole" NOT NULL DEFAULT 'OTHER',
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "notes"     VARCHAR(1000),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "ClientContact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClientContact_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ClientContact_tenantId_idx" ON "ClientContact"("tenantId");
CREATE INDEX "ClientContact_clientId_idx" ON "ClientContact"("clientId");
-- One live primary contact per client.
CREATE UNIQUE INDEX "ClientContact_one_primary_per_client" ON "ClientContact"("clientId") WHERE "isPrimary" AND "deletedAt" IS NULL;

-- Under the wall (20270128190100_tenancy_rls).
SELECT alto_tenant_rls_policies('ClientContact');
ALTER TABLE "ClientContact" ENABLE ROW LEVEL SECURITY;
