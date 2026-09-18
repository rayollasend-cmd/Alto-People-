-- Floor supervisors report to a shift supervisor, help on their shift's SOP,
-- and run it when the shift supervisor hands them the shift (or isn't on
-- the clock).

ALTER TABLE "User" ADD COLUMN "leadUserId" UUID;
ALTER TABLE "User"
  ADD CONSTRAINT "User_leadUserId_fkey" FOREIGN KEY ("leadUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "User_leadUserId_idx" ON "User"("leadUserId");

ALTER TABLE "OpsShift" ADD COLUMN "coveringForId" UUID;
ALTER TABLE "OpsShift"
  ADD CONSTRAINT "OpsShift_coveringForId_fkey" FOREIGN KEY ("coveringForId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "OpsShift_locationId_windowLabel_dueAt_idx" ON "OpsShift"("locationId", "windowLabel", "dueAt");

CREATE TABLE "ShiftCover" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "leadUserId" UUID NOT NULL,
    "coverUserId" UUID NOT NULL,
    "fromDate" VARCHAR(10) NOT NULL,
    "toDate" VARCHAR(10) NOT NULL,
    "note" VARCHAR(500),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(6),

    CONSTRAINT "ShiftCover_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShiftCover_leadUserId_toDate_idx" ON "ShiftCover"("leadUserId", "toDate");
CREATE INDEX "ShiftCover_coverUserId_toDate_idx" ON "ShiftCover"("coverUserId", "toDate");

ALTER TABLE "ShiftCover"
  ADD CONSTRAINT "ShiftCover_leadUserId_fkey" FOREIGN KEY ("leadUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShiftCover"
  ADD CONSTRAINT "ShiftCover_coverUserId_fkey" FOREIGN KEY ("coverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShiftCover"
  ADD CONSTRAINT "ShiftCover_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
