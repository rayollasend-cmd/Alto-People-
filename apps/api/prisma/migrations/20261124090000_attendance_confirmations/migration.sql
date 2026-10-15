-- Agent families step 2 — the Workforce agent's attendance.confirm
-- (docs/agent-families-investigation.md §4; cut-off approved by the owner 2026-10-15).
--
-- Additive: one table. One ask per shift; the answer and the backup proposal
-- it filed live on the row. The CHECKs keep the closed sets closed.

-- CreateTable
CREATE TABLE "AttendanceConfirmation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shiftId" UUID NOT NULL,
    "associateId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "sentAt" TIMESTAMPTZ(6) NOT NULL,
    "cutoffAt" TIMESTAMPTZ(6) NOT NULL,
    "answer" VARCHAR(10),
    "answeredAt" TIMESTAMPTZ(6),
    "answeredVia" VARCHAR(20),
    "backupProposalId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,

    CONSTRAINT "AttendanceConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceConfirmation_shiftId_key" ON "AttendanceConfirmation"("shiftId");

-- CreateIndex
CREATE INDEX "AttendanceConfirmation_associateId_sentAt_idx" ON "AttendanceConfirmation"("associateId", "sentAt");

-- CreateIndex
CREATE INDEX "AttendanceConfirmation_tenantId_idx" ON "AttendanceConfirmation"("tenantId");

-- AddForeignKey
ALTER TABLE "AttendanceConfirmation" ADD CONSTRAINT "AttendanceConfirmation_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceConfirmation" ADD CONSTRAINT "AttendanceConfirmation_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The closed sets.
ALTER TABLE "AttendanceConfirmation" ADD CONSTRAINT "AttendanceConfirmation_channel_check" CHECK ("channel" IN ('WHATSAPP', 'IN_APP'));
ALTER TABLE "AttendanceConfirmation" ADD CONSTRAINT "AttendanceConfirmation_answer_check" CHECK ("answer" IS NULL OR "answer" IN ('YES', 'NO'));
ALTER TABLE "AttendanceConfirmation" ADD CONSTRAINT "AttendanceConfirmation_answeredVia_check" CHECK ("answeredVia" IS NULL OR "answeredVia" IN ('APP', 'WHATSAPP'));
ALTER TABLE "AttendanceConfirmation" ADD CONSTRAINT "AttendanceConfirmation_answered_check" CHECK (("answer" IS NULL) = ("answeredAt" IS NULL));
