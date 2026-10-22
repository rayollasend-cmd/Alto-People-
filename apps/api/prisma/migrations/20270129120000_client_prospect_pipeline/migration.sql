-- The new-business pipeline (Clients rebuild, 2026-10-22).
--
-- ClientProspect learns who owns it, who the contact is, when the work would
-- start, why it was lost, which client it became, and when its stage last
-- changed (the board's "days in stage"). The table is already tenant-keyed and
-- under the database wall (20270128190100_tenancy_rls); no new table here.

ALTER TABLE "ClientProspect"
  ADD COLUMN "ownerUserId" UUID,
  ADD COLUMN "expectedStartDate" DATE,
  ADD COLUMN "contactName" VARCHAR(120),
  ADD COLUMN "contactEmail" VARCHAR(254),
  ADD COLUMN "lostReason" VARCHAR(500),
  ADD COLUMN "wonClientId" UUID,
  ADD COLUMN "stageChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing rows: the last edit is the best date we hold for the last stage
-- change (the column is new, so nothing better was recorded).
UPDATE "ClientProspect" SET "stageChangedAt" = "updatedAt";

CREATE INDEX "ClientProspect_ownerUserId_idx" ON "ClientProspect"("ownerUserId");
CREATE INDEX "ClientProspect_wonClientId_idx" ON "ClientProspect"("wonClientId");

ALTER TABLE "ClientProspect" ADD CONSTRAINT "ClientProspect_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClientProspect" ADD CONSTRAINT "ClientProspect_wonClientId_fkey"
  FOREIGN KEY ("wonClientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
