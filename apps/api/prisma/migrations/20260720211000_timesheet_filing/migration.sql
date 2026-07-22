-- Recorded Fieldglass filings: a per-worker hours snapshot + total for a
-- Sat→Fri week (optionally one client), so later edits to the underlying
-- time entries surface as drift on the Timesheets page.
CREATE TABLE "TimesheetFiling" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "weekStart" DATE NOT NULL,
    "clientId" UUID,
    "filedById" UUID,
    "filedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "totalHours" DECIMAL(10,2) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "TimesheetFiling_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TimesheetFiling_weekStart_clientId_key" ON "TimesheetFiling"("weekStart", "clientId");
CREATE INDEX "TimesheetFiling_weekStart_idx" ON "TimesheetFiling"("weekStart");
