-- Carrier acknowledgments for 834 enrollment files (lib/ediAck, lib/carrierAcks).
--
-- A carrier answers an 834 with a TA1 (the interchange) and/or a 999 (the
-- group and each transaction set). Each answer is kept as an Edi834Ack,
-- matched to the file by carrier + control number (TA101 = ISA13, AK102 =
-- GS06); one that matches nothing is kept with no file. The file carries
-- the deciding answer (ackStatus / ackedAt). The carrier records the last
-- look in its SFTP folder for answers (ackCheckedAt / ackCheckError).
-- Tenant-keyed and under the wall (20270128190100_tenancy_rls).

ALTER TABLE "BenefitCarrier" ADD COLUMN "ackCheckedAt" TIMESTAMPTZ(6);
ALTER TABLE "BenefitCarrier" ADD COLUMN "ackCheckError" VARCHAR(500);

ALTER TABLE "Edi834File" ADD COLUMN "ackStatus" VARCHAR(24);
ALTER TABLE "Edi834File" ADD COLUMN "ackedAt" TIMESTAMPTZ(6);

CREATE TABLE "Edi834Ack" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "carrierId" UUID NOT NULL,
  "fileId" UUID,
  "kind" VARCHAR(8) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "controlNumber" INTEGER,
  "errors" JSONB NOT NULL DEFAULT '[]',
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "content" TEXT NOT NULL,
  "source" VARCHAR(8) NOT NULL,
  "sourceRef" VARCHAR(600),
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedById" UUID,
  CONSTRAINT "Edi834Ack_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Edi834Ack_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "BenefitCarrier"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Edi834Ack_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "Edi834File"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Edi834Ack_tenantId_carrierId_sourceRef_key" ON "Edi834Ack"("tenantId", "carrierId", "sourceRef");
CREATE INDEX "Edi834Ack_carrierId_receivedAt_idx" ON "Edi834Ack"("carrierId", "receivedAt");
CREATE INDEX "Edi834Ack_fileId_idx" ON "Edi834Ack"("fileId");
CREATE INDEX "Edi834Ack_tenantId_idx" ON "Edi834Ack"("tenantId");

-- Under the wall (20270128190100_tenancy_rls).
SELECT alto_tenant_rls_policies('Edi834Ack');
ALTER TABLE "Edi834Ack" ENABLE ROW LEVEL SECURITY;
