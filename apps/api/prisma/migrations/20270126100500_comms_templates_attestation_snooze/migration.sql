-- Communications: a broadcast saved as a template ("Save as template") keeps
-- its name here and is never sent; "Use" copies it into a new draft.
ALTER TABLE "Broadcast" ADD COLUMN "templateName" VARCHAR(120);

-- Compliance attestations: HR can put one signal's reminders off until a
-- date. The daily digest (lib/attestationReminder) leaves snoozed signals out.
CREATE TABLE "AttestationSnooze" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"     UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "key"          VARCHAR(64) NOT NULL,
  "periodStart"  DATE NOT NULL,
  "snoozedUntil" TIMESTAMPTZ(6) NOT NULL,
  "createdById"  UUID,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AttestationSnooze_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttestationSnooze_tenantId_key_periodStart_key" ON "AttestationSnooze"("tenantId", "key", "periodStart");
CREATE INDEX "AttestationSnooze_tenantId_idx" ON "AttestationSnooze"("tenantId");
