-- Store-shift SOP: a supervisor's clock-in opens their store shift's SOP.

ALTER TABLE "OpsShift"
  ADD COLUMN "locationId" UUID,
  ADD COLUMN "windowLabel" VARCHAR(80),
  ADD COLUMN "timeEntryId" UUID,
  ADD COLUMN "dueAt" TIMESTAMPTZ(6),
  ADD COLUMN "incompleteReason" VARCHAR(1000),
  ADD COLUMN "handoverNone" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "remindedAt" TIMESTAMPTZ(6),
  ADD COLUMN "escalatedAt" TIMESTAMPTZ(6);

ALTER TABLE "OpsShift"
  ADD CONSTRAINT "OpsShift_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "OpsShift_openedById_status_idx" ON "OpsShift"("openedById", "status");
CREATE INDEX "OpsShift_locationId_status_idx" ON "OpsShift"("locationId", "status");

CREATE TABLE "StoreShiftSop" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "locationId" UUID NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "templateId" UUID NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "StoreShiftSop_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreShiftSop_locationId_label_key" ON "StoreShiftSop"("locationId", "label");
CREATE INDEX "StoreShiftSop_templateId_idx" ON "StoreShiftSop"("templateId");

ALTER TABLE "StoreShiftSop"
  ADD CONSTRAINT "StoreShiftSop_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreShiftSop"
  ADD CONSTRAINT "StoreShiftSop_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OpsSopTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
