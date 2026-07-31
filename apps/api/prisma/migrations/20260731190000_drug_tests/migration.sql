-- Drug-screen ledger, mirroring BackgroundCheck.
--
-- The Walmart SOW (Exhibit E) requires a drug test result within 60 days,
-- so unlike background checks this recurs: the "needs a test" roster is
-- driven by the recency of DRUG_TEST_RESULT documents, not by whether a
-- ledger row ever existed. This table records orders placed with the
-- provider and their outcomes; result PDFs stay in DocumentRecord.

CREATE TYPE "DrugTestStatus" AS ENUM ('INITIATED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'NEEDS_REVIEW');

CREATE TABLE "DrugTest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "clientId" UUID,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "status" "DrugTestStatus" NOT NULL DEFAULT 'INITIATED',
    "initiatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "DrugTest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DrugTest_associateId_idx" ON "DrugTest"("associateId");
CREATE INDEX "DrugTest_status_idx" ON "DrugTest"("status");
CREATE INDEX "DrugTest_clientId_idx" ON "DrugTest"("clientId");

ALTER TABLE "DrugTest" ADD CONSTRAINT "DrugTest_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
