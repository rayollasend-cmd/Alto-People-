-- Brief 2-3 step 3: tenant roles over archetypes, SCIM groups and group → role mapping.
CREATE TABLE "TenantRole" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "archetype" "Role" NOT NULL,
    "capabilities" TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "TenantRole_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TenantRole_tenantId_idx" ON "TenantRole"("tenantId");

ALTER TABLE "User" ADD COLUMN "tenantRoleId" UUID;
ALTER TABLE "User" ADD CONSTRAINT "User_tenantRoleId_fkey" FOREIGN KEY ("tenantRoleId") REFERENCES "TenantRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ScimGroup" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "displayName" VARCHAR(200) NOT NULL,
    "externalId" VARCHAR(200),
    "memberUserIds" UUID[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ScimGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ScimGroup_tenantId_displayName_key" ON "ScimGroup"("tenantId", "displayName");

CREATE TABLE "ScimGroupRoleMap" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "groupName" VARCHAR(200) NOT NULL,
    "archetype" "Role" NOT NULL,
    "tenantRoleId" UUID,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScimGroupRoleMap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ScimGroupRoleMap_tenantId_groupName_key" ON "ScimGroupRoleMap"("tenantId", "groupName");
ALTER TABLE "ScimGroupRoleMap" ADD CONSTRAINT "ScimGroupRoleMap_tenantRoleId_fkey" FOREIGN KEY ("tenantRoleId") REFERENCES "TenantRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
