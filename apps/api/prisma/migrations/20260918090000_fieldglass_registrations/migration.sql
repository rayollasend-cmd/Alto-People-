-- Finance worklist state: which associates have been registered in
-- Fieldglass. The dashboard queue = approved+scheduled associates with
-- NO row here; "Mark added" inserts one with attribution. Storing only
-- COMPLETIONS keeps the queue computed (no backfill risk: the overview
-- query windows to recent approvals, so historical associates never
-- flood the list on first deploy).
CREATE TABLE "FieldglassRegistration" (
  "associateId" UUID NOT NULL,
  "addedById"   UUID,
  "addedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FieldglassRegistration_pkey" PRIMARY KEY ("associateId"),
  CONSTRAINT "FieldglassRegistration_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FieldglassRegistration_addedById_fkey"
    FOREIGN KEY ("addedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);
