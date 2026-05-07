-- Manual compliance attestation — backs the billing/invoicing scorecard
-- tile so HR can confirm Fieldglass / Walmart-portal actions on a
-- recurring cadence, without us building a real Fieldglass integration.
--
-- One row per (key, periodStart). key is a string (not enum) so future
-- signals can ship without a schema migration. attestedById is Restrict
-- on delete so an audit row can never become orphaned.

CREATE TYPE "ManualAttestationOutcome" AS ENUM ('YES', 'NO', 'NOT_APPLICABLE');

CREATE TABLE "ManualComplianceAttestation" (
  "id"                  UUID                       NOT NULL DEFAULT gen_random_uuid(),
  "key"                 VARCHAR(64)                NOT NULL,
  "periodStart"         DATE                       NOT NULL,
  "periodEnd"           DATE                       NOT NULL,
  "outcome"             "ManualAttestationOutcome" NOT NULL,
  "actionTakenAt"       TIMESTAMPTZ(6),
  "attestedById"        UUID                       NOT NULL,
  "attestedAt"          TIMESTAMPTZ(6)             NOT NULL DEFAULT NOW(),
  "notes"               TEXT,
  "evidenceDocumentId"  UUID,

  CONSTRAINT "ManualComplianceAttestation_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "ManualComplianceAttestation_attestedBy_fkey"
    FOREIGN KEY ("attestedById")
    REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "ManualComplianceAttestation_evidenceDocument_fkey"
    FOREIGN KEY ("evidenceDocumentId")
    REFERENCES "DocumentRecord"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,

  -- periodEnd must be on/after periodStart.
  CONSTRAINT "ManualComplianceAttestation_period_chk"
    CHECK ("periodEnd" >= "periodStart")
);

-- One attestation per (key, periodStart). Re-attesting overwrites via
-- upsert at the route layer rather than creating a second row.
CREATE UNIQUE INDEX "ManualComplianceAttestation_key_periodStart_key"
  ON "ManualComplianceAttestation"("key", "periodStart");

-- Reminder cron scans by key + periodEnd to find unfilled / overdue rows.
CREATE INDEX "ManualComplianceAttestation_key_periodEnd_idx"
  ON "ManualComplianceAttestation"("key", "periodEnd");
