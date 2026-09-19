-- The Fieldglass desk: the Worker ID Fieldglass assigns, and each worker's
-- weekly Fieldglass timesheet — entered by Alto, and its status, ID,
-- revision and hours as the buyer's Fieldglass has them.
ALTER TABLE "FieldglassRegistration" ADD COLUMN "workerId" VARCHAR(40);

CREATE TABLE "FieldglassTimesheet" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "weekStart" DATE NOT NULL,
    "associateId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "enteredAt" TIMESTAMPTZ(6),
    "enteredById" UUID,
    "enteredHours" DECIMAL(8,2),
    "fgStatus" VARCHAR(20),
    "fgTimesheetId" VARCHAR(40),
    "fgRevision" INTEGER,
    "fgHours" DECIMAL(8,2),
    "fgSyncedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "FieldglassTimesheet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FieldglassTimesheet_weekStart_associateId_clientId_key" ON "FieldglassTimesheet"("weekStart", "associateId", "clientId");
CREATE INDEX "FieldglassTimesheet_weekStart_clientId_idx" ON "FieldglassTimesheet"("weekStart", "clientId");
ALTER TABLE "FieldglassTimesheet" ADD CONSTRAINT "FieldglassTimesheet_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FieldglassTimesheet" ADD CONSTRAINT "FieldglassTimesheet_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
