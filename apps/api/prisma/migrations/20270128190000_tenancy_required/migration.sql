-- Brief 2-1 §9.7 step 3 — Migration C: the tenant is required, and the keys
-- that were unique for the one employer are unique per tenant.
--
-- Written for a live database with one tenant (Alto HR):
--   * tenantId: any NULL is backfilled to Alto HR, then SET NOT NULL. The
--     database default stays, so every create path that does not name a
--     tenant keeps working. AuditLog (null = the platform's own chain) and
--     ReleaseNote (null = a note for every tenant) keep their nullable column,
--     as do the platform telemetry tables that never had a default.
--   * Every unique rewrite only ADDS tenantId to an existing key, so the rows
--     already there satisfy the new index. User.email and JobPosting.slug stay
--     global (decision 1; the public careers URL resolves its tenant by slug).
--   * Singletons: the fixed id can only ever have held one row, so the unique
--     tenantId fits; new tenants' rows take a random id.
--   * Pay-check numbers become a per-tenant counter (TenantCounter), seeded
--     from Alto HR's last number; no existing check is renumbered.
--   * A lock wait or a deadlock with the running app retries the statement
--     instead of failing the deploy (pg_temp.alto_ddl).

CREATE FUNCTION pg_temp.alto_ddl(stmt text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  attempt int := 0;
BEGIN
  LOOP
    BEGIN
      -- Short waits first; after ten tries wait as long as it takes.
      PERFORM set_config('lock_timeout', CASE WHEN attempt < 10 THEN '5s' ELSE '0' END, true);
      EXECUTE stmt;
      PERFORM set_config('lock_timeout', '0', true);
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      attempt := attempt + 1;
      IF attempt > 40 THEN RAISE; END IF;
      RAISE NOTICE 'tenancy migration: retrying after %: %', SQLERRM, left(stmt, 120);
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END
$fn$;

-- Drops a unique key whether it was created as an index or as a constraint.
CREATE FUNCTION pg_temp.alto_drop_key(key_name text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  tbl regclass;
BEGIN
  SELECT conrelid::regclass INTO tbl FROM pg_constraint
   WHERE conname = key_name AND connamespace = current_schema()::regnamespace;
  IF tbl IS NOT NULL THEN
    PERFORM pg_temp.alto_ddl(format('ALTER TABLE %s DROP CONSTRAINT %I', tbl, key_name));
  ELSE
    PERFORM pg_temp.alto_ddl(format('DROP INDEX IF EXISTS %I', key_name));
  END IF;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 1. tenantId NOT NULL on every tenant-keyed table
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  has_null boolean;
BEGIN
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = current_schema()
       AND c.column_name = 'tenantId'
       AND c.is_nullable = 'YES'
       AND c.column_default LIKE '%00000000-0000-4000-8000-000000000001%'
       AND c.table_name NOT IN ('AuditLog', 'ReleaseNote')
     ORDER BY c.table_name
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE "tenantId" IS NULL)', r.table_name) INTO has_null;
    IF has_null THEN
      RAISE NOTICE 'tenancy migration: % had rows with no tenant; backfilled to Alto HR', r.table_name;
      -- An append-only table's row guard would refuse the backfill; lift it for this one statement.
      PERFORM pg_temp.alto_ddl(format('ALTER TABLE %I DISABLE TRIGGER USER', r.table_name));
      PERFORM pg_temp.alto_ddl(format('UPDATE %I SET "tenantId" = %L::uuid WHERE "tenantId" IS NULL', r.table_name, '00000000-0000-4000-8000-000000000001'));
      PERFORM pg_temp.alto_ddl(format('ALTER TABLE %I ENABLE TRIGGER USER', r.table_name));
    END IF;
    PERFORM pg_temp.alto_ddl(format('ALTER TABLE %I ALTER COLUMN "tenantId" SET NOT NULL', r.table_name));
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Keys unique per tenant (investigation §2.3)
-- ---------------------------------------------------------------------------
-- Prisma-declared keys (schema.prisma @@unique([tenantId, …])).
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "Associate_tenantId_email_key" ON "Associate"("tenantId", "email")$$);
SELECT pg_temp.alto_drop_key('Associate_email_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "Candidate_tenantId_email_key" ON "Candidate"("tenantId", "email")$$);
SELECT pg_temp.alto_drop_key('Candidate_email_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "Sponsor_tenantId_name_key" ON "Sponsor"("tenantId", "name")$$);
SELECT pg_temp.alto_drop_key('Sponsor_name_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "WorktagCategory_tenantId_key_key" ON "WorktagCategory"("tenantId", "key")$$);
SELECT pg_temp.alto_drop_key('WorktagCategory_key_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "ExecDecisionState_tenantId_key_key" ON "ExecDecisionState"("tenantId", "key")$$);
SELECT pg_temp.alto_drop_key('ExecDecisionState_key_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "DecisionClaim_tenantId_key_key" ON "DecisionClaim"("tenantId", "key")$$);
SELECT pg_temp.alto_drop_key('DecisionClaim_key_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "DecisionNextStep_tenantId_key_key" ON "DecisionNextStep"("tenantId", "key")$$);
SELECT pg_temp.alto_drop_key('DecisionNextStep_key_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "ComplianceActionState_tenantId_actionKey_key" ON "ComplianceActionState"("tenantId", "actionKey")$$);
SELECT pg_temp.alto_drop_key('ComplianceActionState_actionKey_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "RelayClaim_tenantId_subjectType_subjectKey_key" ON "RelayClaim"("tenantId", "subjectType", "subjectKey")$$);
SELECT pg_temp.alto_drop_key('RelayClaim_subjectType_subjectKey_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "ManualComplianceAttestation_tenantId_key_periodStart_key" ON "ManualComplianceAttestation"("tenantId", "key", "periodStart")$$);
SELECT pg_temp.alto_drop_key('ManualComplianceAttestation_key_periodStart_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "RecruitingSourceSpend_tenantId_source_month_key" ON "RecruitingSourceSpend"("tenantId", "source", "month")$$);
SELECT pg_temp.alto_drop_key('RecruitingSourceSpend_source_month_key');
-- Decision 4: a workers'-comp rate is the employer's.
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "WcClassCode_tenantId_stateCode_code_effectiveFrom_key" ON "WcClassCode"("tenantId", "stateCode", "code", "effectiveFrom")$$);
SELECT pg_temp.alto_drop_key('WcClassCode_unique');
SELECT pg_temp.alto_drop_key('WcClassCode_stateCode_code_effectiveFrom_key');
-- Decision 6: the four-digit employee number is unique within a tenant (10,000 each).
-- The per-client indexes from 20260427210000 were never dropped (the drop named
-- "_key" indexes that did not exist); the associate and tenant keys cover them.
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "KioskPin_tenantId_pinHmac_key" ON "KioskPin"("tenantId", "pinHmac")$$);
SELECT pg_temp.alto_drop_key('KioskPin_pinHmac_key');
SELECT pg_temp.alto_drop_key('KioskPin_clientId_pinHmac_unique');
SELECT pg_temp.alto_drop_key('KioskPin_clientId_associateId_unique');

-- SQL-only keys (expressions and partial indexes Prisma cannot declare).
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "Skill_tenant_name_lower_key" ON "Skill"("tenantId", lower("name"))$$);
SELECT pg_temp.alto_drop_key('Skill_name_lower_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "Asset_tenant_kind_serial_key" ON "Asset"("tenantId", "kind", "serial") WHERE "serial" IS NOT NULL$$);
SELECT pg_temp.alto_drop_key('Asset_kind_serial_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldDefinition_tenant_global_key_unique" ON "CustomFieldDefinition"("tenantId", "entityType", "key") WHERE "clientId" IS NULL AND "deletedAt" IS NULL$$);
SELECT pg_temp.alto_drop_key('CustomFieldDefinition_global_key_unique');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "Holiday_tenant_client_date_name_key" ON "Holiday"("tenantId", COALESCE("clientId", '00000000-0000-0000-0000-000000000000'::uuid), "date", "name")$$);
SELECT pg_temp.alto_drop_key('Holiday_client_date_name_key');
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "KbArticle_tenant_client_slug_key" ON "KbArticle"("tenantId", COALESCE("clientId", '00000000-0000-0000-0000-000000000000'::uuid), "slug")$$);
SELECT pg_temp.alto_drop_key('KbArticle_client_slug_key');
-- Two tenants' filed 941 (or 940) for the same quarter no longer collide.
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "TaxForm_tenant_unique_filed" ON "TaxForm"("tenantId", "kind", "taxYear", COALESCE("quarter", 0), COALESCE("associateId", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "status" = 'FILED'$$);
SELECT pg_temp.alto_drop_key('TaxForm_unique_filed');
-- The company-wide (no client) filing for a week is one per tenant.
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "TimesheetFiling_tenant_weekStart_null_client_key" ON "TimesheetFiling"("tenantId", "weekStart") WHERE "clientId" IS NULL$$);
SELECT pg_temp.alto_drop_key('TimesheetFiling_weekStart_null_client_key');
-- The company-wide VTO policy is one per tenant. It was never enforced, so
-- the index is only added where the data already agrees (a NOTICE says if not).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "VtoPolicy" WHERE "clientId" IS NULL GROUP BY "tenantId" HAVING count(*) > 1) THEN
    RAISE NOTICE 'tenancy migration: VtoPolicy has more than one company-wide row for a tenant; the one-per-tenant index was not added';
  ELSE
    PERFORM pg_temp.alto_ddl($i$CREATE UNIQUE INDEX IF NOT EXISTS "VtoPolicy_tenant_noclient_key" ON "VtoPolicy"("tenantId") WHERE "clientId" IS NULL$i$);
  END IF;
END $$;
-- After NOT NULL no row can match "tenantId IS NULL"; the per-tenant built-in key stays.
SELECT pg_temp.alto_drop_key('AgentProfile_notenant_builtInKey_key');

-- ---------------------------------------------------------------------------
-- 3. Singletons: one row per tenant
-- ---------------------------------------------------------------------------
-- OrgSetting already keys on tenantId (20261213100000); its id default goes.
-- SubmitterProfile, ProgramAlertSetting and TransportSettings had a fixed id
-- (so one row at most); they key on tenantId now. Alto HR keeps its row and id.
-- AgentControl stays the PLATFORM switch (operator only); each tenant's own
-- switch is AgentTenantControl (20261123090000).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('SubmitterProfile', 'singleton'), ('ProgramAlertSetting', 'singleton'), ('TransportSettings', 'default')) AS v(tbl, fixed) LOOP
    -- Should a tenant somehow hold two rows: the fixed-id row wins, else the latest.
    EXECUTE format(
      'DELETE FROM %1$I a USING %1$I b WHERE a."tenantId" = b."tenantId" AND a.id <> b.id
         AND (b.id = %2$L OR (a.id <> %2$L AND (a."updatedAt", a.id) < (b."updatedAt", b.id)))',
      r.tbl, r.fixed);
    PERFORM pg_temp.alto_drop_key(r.tbl || '_tenantId_idx');
    PERFORM pg_temp.alto_ddl(format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I ("tenantId")', r.tbl || '_tenantId_key', r.tbl));
  END LOOP;
END $$;
SELECT pg_temp.alto_ddl($$ALTER TABLE "OrgSetting" ALTER COLUMN "id" SET DEFAULT substr(md5((gen_random_uuid())::text), 1, 16)$$);
SELECT pg_temp.alto_ddl($$ALTER TABLE "SubmitterProfile" ALTER COLUMN "id" SET DEFAULT substr(md5((gen_random_uuid())::text), 1, 16)$$);
SELECT pg_temp.alto_ddl($$ALTER TABLE "ProgramAlertSetting" ALTER COLUMN "id" SET DEFAULT substr(md5((gen_random_uuid())::text), 1, 16)$$);
SELECT pg_temp.alto_ddl($$ALTER TABLE "TransportSettings" ALTER COLUMN "id" SET DEFAULT substr(md5((gen_random_uuid())::text), 1, 16)$$);

-- ---------------------------------------------------------------------------
-- 4. Pay-check numbers: a counter per tenant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "TenantCounter" (
  "tenantId"  UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "key"       VARCHAR(60) NOT NULL,
  "value"     INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantCounter_pkey" PRIMARY KEY ("tenantId", "key")
);

-- Seed: each tenant carries on from its highest check number; Alto HR also
-- from the old global sequence, so a number once issued (even on a check
-- since deleted with its paycheck) is never issued again.
DO $$
DECLARE
  seq text := pg_get_serial_sequence('"PayCheck"', 'checkNumber');
  seq_value bigint := 0;
BEGIN
  IF seq IS NOT NULL THEN
    -- The last number the sequence handed out (one before its next, if never called).
    EXECUTE format('SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM %s', seq) INTO seq_value;
  END IF;
  INSERT INTO "TenantCounter" ("tenantId", "key", "value", "updatedAt")
  SELECT t."id", 'pay_check_number',
         GREATEST(
           COALESCE((SELECT max(p."checkNumber") FROM "PayCheck" p WHERE p."tenantId" = t."id"), 0),
           CASE WHEN t."id" = '00000000-0000-4000-8000-000000000001'::uuid THEN seq_value ELSE 0 END
         ),
         CURRENT_TIMESTAMP
    FROM "Tenant" t
  ON CONFLICT ("tenantId", "key") DO NOTHING;
END $$;

-- The next number is taken in the inserting transaction (the counter row is
-- locked until it commits, so two checks never share a number). A caller that
-- names its own number keeps it, and the counter moves past it.
CREATE OR REPLACE FUNCTION alto_pay_check_number() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."checkNumber" IS NULL THEN
    INSERT INTO "TenantCounter" AS c ("tenantId", "key", "value", "updatedAt")
    VALUES (NEW."tenantId", 'pay_check_number', 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId", "key") DO UPDATE SET "value" = c."value" + 1, "updatedAt" = CURRENT_TIMESTAMP
    RETURNING c."value" INTO NEW."checkNumber";
  ELSE
    INSERT INTO "TenantCounter" AS c ("tenantId", "key", "value", "updatedAt")
    VALUES (NEW."tenantId", 'pay_check_number', NEW."checkNumber", CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId", "key") DO UPDATE SET "value" = GREATEST(c."value", EXCLUDED."value"), "updatedAt" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS pay_check_number ON "PayCheck";
CREATE TRIGGER pay_check_number BEFORE INSERT ON "PayCheck" FOR EACH ROW EXECUTE FUNCTION alto_pay_check_number();

-- The global sequence stops numbering (it stays, unused, for a rollback).
SELECT pg_temp.alto_ddl($$ALTER TABLE "PayCheck" ALTER COLUMN "checkNumber" DROP DEFAULT$$);
SELECT pg_temp.alto_ddl($$CREATE UNIQUE INDEX IF NOT EXISTS "PayCheck_tenantId_checkNumber_key" ON "PayCheck"("tenantId", "checkNumber")$$);
SELECT pg_temp.alto_drop_key('PayCheck_checkNumber_key');
