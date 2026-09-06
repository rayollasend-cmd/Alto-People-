-- Fieldglass registrations learn WHICH CLIENT the worker is registered
-- under, so a cross-client transfer becomes detectable: registration says
-- client A, the associate's open assignment says client B → the finance
-- queue shows "close in A, open under B".
ALTER TABLE "FieldglassRegistration"
  ADD COLUMN "clientId" UUID;

ALTER TABLE "FieldglassRegistration"
  ADD CONSTRAINT "FieldglassRegistration_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing rows: the client of the associate's current OPEN
-- assignment, else their latest APPROVED application's client — the same
-- resolution order the runtime uses.
UPDATE "FieldglassRegistration" fr
SET "clientId" = COALESCE(
  (
    SELECT l."clientId"
    FROM "AssociateAssignment" aa
    JOIN "Location" l ON l."id" = aa."locationId"
    WHERE aa."associateId" = fr."associateId" AND aa."endedAt" IS NULL
    ORDER BY aa."startedAt" DESC
    LIMIT 1
  ),
  (
    SELECT ap."clientId"
    FROM "Application" ap
    WHERE ap."associateId" = fr."associateId" AND ap."status" = 'APPROVED'
    ORDER BY ap."approvedAt" DESC NULLS LAST
    LIMIT 1
  )
);
