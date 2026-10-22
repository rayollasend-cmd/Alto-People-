-- Open shifts: who was asked and who said no (role walk, ops 11).
-- One row per open shift and person on its bench. The bench sweep writes the
-- first send, a manager's Rebroadcast re-sends to whoever is still eligible
-- and has not declined, and "Not for me" on the associate's open-shift card
-- records the decline. The managers' Open shifts tab reads the counts.
-- New table only; no existing rows are rewritten.

CREATE TABLE "OpenShiftInvite" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "shiftId"     UUID NOT NULL,
  "associateId" UUID NOT NULL,
  "firstSentAt" TIMESTAMPTZ(6),
  "lastSentAt"  TIMESTAMPTZ(6),
  "sendCount"   INTEGER NOT NULL DEFAULT 0,
  "declinedAt"  TIMESTAMPTZ(6),
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "OpenShiftInvite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OpenShiftInvite_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OpenShiftInvite_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OpenShiftInvite_shiftId_associateId_key" ON "OpenShiftInvite"("shiftId", "associateId");
CREATE INDEX "OpenShiftInvite_associateId_idx" ON "OpenShiftInvite"("associateId");
CREATE INDEX "OpenShiftInvite_tenantId_idx" ON "OpenShiftInvite"("tenantId");
