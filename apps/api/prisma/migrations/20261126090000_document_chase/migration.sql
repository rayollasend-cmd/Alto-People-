-- Agent families step 4 — the Compliance agent's document.chase
-- (docs/agent-families-investigation.md §4). Additive: one table, one row per
-- chased item, keyed by the compliance scorecard's action key.

-- CreateTable
CREATE TABLE "DocumentChase" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "itemKey" VARCHAR(300) NOT NULL,
    "associateId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMPTZ(6),
    "escalatedAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),
    "resolution" VARCHAR(20),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,

    CONSTRAINT "DocumentChase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChase_itemKey_key" ON "DocumentChase"("itemKey");

-- CreateIndex
CREATE INDEX "DocumentChase_associateId_resolvedAt_idx" ON "DocumentChase"("associateId", "resolvedAt");

-- CreateIndex
CREATE INDEX "DocumentChase_tenantId_resolvedAt_idx" ON "DocumentChase"("tenantId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "DocumentChase" ADD CONSTRAINT "DocumentChase_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "DocumentChase" ADD CONSTRAINT "DocumentChase_closed_sets_check" CHECK ("kind" IN ('DOCUMENT', 'I9_WORK_AUTH', 'VACCINATION') AND "stage" BETWEEN 0 AND 3 AND ("resolution" IS NULL OR "resolution" IN ('RENEWED', 'WAIVED', 'LEFT')) AND (("resolution" IS NULL) = ("resolvedAt" IS NULL)));
