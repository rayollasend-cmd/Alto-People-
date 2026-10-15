-- Agent families step 5 — the Compliance agent's incident.loop
-- (docs/agent-families-investigation.md §4). Additive: three nullable or
-- defaulted columns on OshaIncident; the HR case link clears if the case goes.

-- AlterTable
ALTER TABLE "OshaIncident" ADD COLUMN     "chaseStage" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hrCaseId" UUID,
ADD COLUMN     "lastChasedAt" TIMESTAMPTZ(6);

-- AddForeignKey
ALTER TABLE "OshaIncident" ADD CONSTRAINT "OshaIncident_hrCaseId_fkey" FOREIGN KEY ("hrCaseId") REFERENCES "HrCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "OshaIncident" ADD CONSTRAINT "OshaIncident_chaseStage_check" CHECK ("chaseStage" BETWEEN 0 AND 3);
