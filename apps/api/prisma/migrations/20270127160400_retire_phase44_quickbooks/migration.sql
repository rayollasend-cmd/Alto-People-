-- 2026-10-21 system audit, Tier 3: two QuickBooks integrations were mounted.
-- The Phase-44 per-client payroll connection (/quickbooks, lib/quickbooks.ts)
-- is retired: its tokens have been unreadable since the 2026-06-11 key
-- rotation and the company's own books connection (lib/books/qbo, one per
-- tenant) carries payroll to QuickBooks through the ledger outbox. The
-- per-run and per-associate QBO ids it stamped go with it.

-- Keep the history before it goes: which QuickBooks journal entry each run
-- posted (and reversed), which QBO employee/vendor each associate mapped to,
-- the per-client account mapping and cost-center map. The OAuth tokens are
-- dead and are deliberately not copied. Lives in its own schema so nothing in
-- the app reads it; an accountant can query it if an old entry is questioned.
CREATE SCHEMA IF NOT EXISTS "archive";
CREATE TABLE IF NOT EXISTS "archive"."phase44_quickbooks" (
  "kind"       TEXT NOT NULL,
  "rowId"      UUID NOT NULL,
  "data"       JSONB NOT NULL,
  "archivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

INSERT INTO "archive"."phase44_quickbooks" ("kind", "rowId", "data")
SELECT 'PayrollRun', "id", jsonb_build_object(
         'tenantId', "tenantId",
         'qboJournalEntryId', "qboJournalEntryId",
         'voidJournalEntryId', "voidJournalEntryId",
         'qboSyncedAt', "qboSyncedAt",
         'qboSyncError', "qboSyncError")
  FROM "PayrollRun"
 WHERE "qboJournalEntryId" IS NOT NULL OR "voidJournalEntryId" IS NOT NULL
    OR "qboSyncedAt" IS NOT NULL OR "qboSyncError" IS NOT NULL;

INSERT INTO "archive"."phase44_quickbooks" ("kind", "rowId", "data")
SELECT 'Associate', "id", jsonb_build_object(
         'tenantId', "tenantId",
         'qboEmployeeId', "qboEmployeeId",
         'qboVendorId', "qboVendorId",
         'qboSyncedAt', "qboSyncedAt")
  FROM "Associate"
 WHERE "qboEmployeeId" IS NOT NULL OR "qboVendorId" IS NOT NULL OR "qboSyncedAt" IS NOT NULL;

INSERT INTO "archive"."phase44_quickbooks" ("kind", "rowId", "data")
SELECT 'QuickbooksConnection', "id",
       to_jsonb(c) - 'accessTokenEnc' - 'refreshTokenEnc'
  FROM "QuickbooksConnection" c;

INSERT INTO "archive"."phase44_quickbooks" ("kind", "rowId", "data")
SELECT 'QuickbooksCostCenterMapping', "id", to_jsonb(m)
  FROM "QuickbooksCostCenterMapping" m;

DROP TABLE IF EXISTS "QuickbooksCostCenterMapping";
DROP TABLE IF EXISTS "QuickbooksConnection";
DROP TYPE IF EXISTS "QboJeMode";

ALTER TABLE "PayrollRun"
  DROP COLUMN IF EXISTS "qboJournalEntryId",
  DROP COLUMN IF EXISTS "qboSyncedAt",
  DROP COLUMN IF EXISTS "qboSyncError",
  DROP COLUMN IF EXISTS "voidJournalEntryId";

ALTER TABLE "Associate"
  DROP COLUMN IF EXISTS "qboEmployeeId",
  DROP COLUMN IF EXISTS "qboVendorId",
  DROP COLUMN IF EXISTS "qboSyncedAt";
