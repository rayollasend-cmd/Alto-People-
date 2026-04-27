-- Phase 77 — Effective-dated AssociateHistory.
--
-- Captures the "as-of-when" view of an associate's manager / department /
-- cost-center / job-profile / state / hourly-rate. One row per change with
-- effectiveFrom (inclusive) and effectiveTo (NULL = current). The current
-- value also lives on Associate itself; this table is the audit trail and
-- the source of as-of lookups for retro pay, reporting, and COBRA windows.
--
-- A row is appended when any tracked field changes. The previous current
-- row's effectiveTo is closed to (newRow.effectiveFrom).

CREATE TABLE "AssociateHistory" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "associateId"     UUID NOT NULL,
  "effectiveFrom"   TIMESTAMPTZ(6) NOT NULL,
  "effectiveTo"     TIMESTAMPTZ(6),  -- NULL = current row
  -- Snapshots of the tracked fields at effectiveFrom. NULL = not set
  -- at that time (matches Associate's nullability).
  "managerId"       UUID,
  "departmentId"    UUID,
  "costCenterId"    UUID,
  "jobProfileId"    UUID,
  "state"           VARCHAR(2),
  "hourlyRate"      DECIMAL(8, 2),  -- nullable: not all jobs track an hourly snapshot
  -- Provenance: who made this change and an optional reason ("manual",
  -- "promotion", "department_reorg_2026Q2", etc.). actorUserId is nullable
  -- because backfill / system imports may have no user.
  "reason"          TEXT,
  "actorUserId"     UUID,
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "AssociateHistory_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "AssociateHistory_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "AssociateHistory_window_check"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom")
);

-- As-of lookup index: "given an associate and a timestamp, find the row
-- whose window contains it." Postgres can use this for both range
-- predicates (effectiveFrom <= ts AND (effectiveTo IS NULL OR effectiveTo > ts)).
CREATE INDEX "AssociateHistory_associateId_effectiveFrom_idx"
  ON "AssociateHistory" ("associateId", "effectiveFrom" DESC);

-- Only one current row per associate at a time. The partial unique
-- constraint enforces that effectiveTo IS NULL appears at most once per
-- associate, preventing a write race from leaving two open windows.
CREATE UNIQUE INDEX "AssociateHistory_associateId_current_unique"
  ON "AssociateHistory" ("associateId")
  WHERE "effectiveTo" IS NULL;
