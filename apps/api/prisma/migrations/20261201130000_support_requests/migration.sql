-- Brief 2-6 step 5 — support requests from the help menu to the platform inbox. Additive.

-- CreateTable
CREATE TABLE "SupportRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "requesterUserId" UUID NOT NULL,
    "category" VARCHAR(10) NOT NULL,
    "subject" VARCHAR(160) NOT NULL,
    "body" VARCHAR(5000) NOT NULL,
    "pageUrl" VARCHAR(500),
    "appVersion" VARCHAR(60),
    "status" VARCHAR(12) NOT NULL DEFAULT 'OPEN',
    "reply" VARCHAR(5000),
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SupportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportRequest_tenantId_status_idx" ON "SupportRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SupportRequest_status_createdAt_idx" ON "SupportRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_category_check" CHECK ("category" IN ('QUESTION', 'PROBLEM', 'BILLING', 'ACCOUNT', 'OTHER'));
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_status_check" CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'RESOLVED'));
