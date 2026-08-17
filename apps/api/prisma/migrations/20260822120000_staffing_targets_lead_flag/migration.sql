-- Labor-cost report: staffing targets + lead/associate split.

-- Supervisor/lead flag per position ("Shift Lead") — drives the report's
-- lead-vs-associate headcount and cost split. Position-based so the split
-- can't drift from what people are scheduled (and paid) as.
ALTER TABLE "ShiftPosition" ADD COLUMN "isLead" BOOLEAN NOT NULL DEFAULT false;

-- Expected floor headcount per store, effective-dated: the row with the
-- latest "effectiveFrom" on-or-before a day is that day's target. Rows are
-- never overwritten — past days stay judged by the target that applied
-- then, and the history is the audit trail of coverage changes.
CREATE TABLE "StaffingTarget" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "locationId" UUID NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "StaffingTarget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StaffingTarget_locationId_effectiveFrom_idx"
    ON "StaffingTarget"("locationId", "effectiveFrom");

ALTER TABLE "StaffingTarget"
    ADD CONSTRAINT "StaffingTarget_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffingTarget"
    ADD CONSTRAINT "StaffingTarget_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
