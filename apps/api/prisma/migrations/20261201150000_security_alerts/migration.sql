-- Brief 2-5 step 7 — the security contact and the alerts raised from the audit trail. Additive.

-- AlterTable
ALTER TABLE "OrgSetting" ADD COLUMN     "securityContactEmail" VARCHAR(254);

-- CreateTable
CREATE TABLE "SecurityAlert" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rule" VARCHAR(24) NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "auditLogIds" TEXT[],
    "deliveredTo" TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityAlert_rule_key_createdAt_idx" ON "SecurityAlert"("rule", "key", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAlert_createdAt_idx" ON "SecurityAlert"("createdAt");
