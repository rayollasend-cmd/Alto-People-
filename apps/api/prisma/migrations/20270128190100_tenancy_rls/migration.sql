-- Brief 2-1 §9.5 and §9.7 step 4 — Deploy D, the database wall.
--
-- Row-level security on every tenant-keyed table: a row is visible and
-- writable when its tenantId is the transaction's `app.tenant_id`, or when
-- the transaction opened the audited platform scope (`app.platform_scope`).
-- The app sets both per transaction (lib/tenantRls, TENANCY_RLS=on).
--
-- ENABLED, NOT FORCED. A table's owner (and a superuser, and any role with
-- the owner's privileges) bypasses a policy that is not forced, and the app
-- connects as the owner today, so nothing changes in production until the
-- owner switches DATABASE_URL to the non-owner role (scripts/create-app-role.sql,
-- docs/runbooks/tenancy-rls-cutover.md). No role is created here: the deploy
-- user may lack CREATEROLE.
--
-- One safety valve: when a login role that is NOT the owner can already read
-- the tables (the app may be connecting as one), enabling the policies would
-- hide every row from it at once. Then the policies are created but left
-- disabled, a WARNING names the roles, and the owner enables them with
-- `SELECT alto_enable_all_tenant_rls();` after the review the runbook gives.
--
-- Not under the wall: the tables with no tenant (Tenant, PayrollConfig,
-- LocalTaxRule, GeoCache, MarketWage, BillingPrice, EncryptionCanary,
-- SecurityAlert, SamlCache) and the platform telemetry (ApiBoot,
-- RouteUsageDaily, WebVitalDaily, ProductEventDaily, ReliabilityWeek,
-- ComplianceEvidence, ComplianceEvidenceSignoff).

CREATE OR REPLACE FUNCTION pg_temp.alto_ddl(stmt text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  attempt int := 0;
BEGIN
  LOOP
    BEGIN
      PERFORM set_config('lock_timeout', CASE WHEN attempt < 10 THEN '5s' ELSE '0' END, true);
      EXECUTE stmt;
      PERFORM set_config('lock_timeout', '0', true);
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      attempt := attempt + 1;
      IF attempt > 40 THEN RAISE; END IF;
      RAISE NOTICE 'tenancy rls: retrying after %: %', SQLERRM, left(stmt, 120);
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END
$fn$;

-- The transaction's tenant ('' after a transaction-local setting ends reads as none).
CREATE OR REPLACE FUNCTION alto_rls_tenant() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS
$fn$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $fn$;

-- The audited platform scope (lib/tenant withPlatformScope / withIdentityScope).
CREATE OR REPLACE FUNCTION alto_rls_platform() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS
$fn$ SELECT COALESCE(current_setting('app.platform_scope', true), '') = 'on' $fn$;

-- The policies for one table. A later migration that adds a tenant-keyed
-- table calls `SELECT alto_tenant_rls_policies('NewTable');` and then
-- `ALTER TABLE "NewTable" ENABLE ROW LEVEL SECURITY;` (the rlsWall test's
-- coverage check fails until it does).
--   shared_nulls: rows with no tenant are readable by every tenant
--                 (ReleaseNote's platform notes, LaborRuleSet's shipped packs).
CREATE OR REPLACE FUNCTION alto_tenant_rls_policies(tbl text, shared_nulls boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  rel regclass := format('%I', tbl)::regclass;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = rel AND polname = 'tenant_isolation') THEN
    EXECUTE format('DROP POLICY tenant_isolation ON %I', tbl);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = rel AND polname = 'platform_scope') THEN
    EXECUTE format('DROP POLICY platform_scope ON %I', tbl);
  END IF;
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = alto_rls_tenant()%s) WITH CHECK ("tenantId" = alto_rls_tenant())',
    tbl, CASE WHEN shared_nulls THEN ' OR "tenantId" IS NULL' ELSE '' END);
  EXECUTE format('CREATE POLICY platform_scope ON %I USING (alto_rls_platform()) WITH CHECK (alto_rls_platform())', tbl);
END
$fn$;

-- Every table that carries the policies, for the owner's enable / disable switches.
CREATE OR REPLACE FUNCTION alto_tenant_rls_tables() RETURNS SETOF regclass LANGUAGE sql STABLE AS
$fn$ SELECT DISTINCT p.polrelid::regclass FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE p.polname = 'tenant_isolation' AND c.relnamespace = current_schema()::regnamespace $fn$;

CREATE OR REPLACE FUNCTION alto_enable_all_tenant_rls() RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE t regclass; n integer := 0;
BEGIN
  FOR t IN SELECT * FROM alto_tenant_rls_tables() LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$fn$;

-- The rollback switch (the owner's, in an emergency): every row visible to every role again.
CREATE OR REPLACE FUNCTION alto_disable_all_tenant_rls() RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE t regclass; n integer := 0;
BEGIN
  FOR t IN SELECT * FROM alto_tenant_rls_tables() LOOP
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', t);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$fn$;

DO $$
DECLARE
  r record;
  owner_oid oid;
  readers text;
  tables integer := 0;
BEGIN
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = current_schema()
       AND c.column_name = 'tenantId'
       AND c.table_name NOT IN ('ApiBoot', 'RouteUsageDaily', 'WebVitalDaily', 'ProductEventDaily', 'ReliabilityWeek', 'ComplianceEvidence', 'ComplianceEvidenceSignoff')
     ORDER BY c.table_name
  LOOP
    PERFORM pg_temp.alto_ddl(format('SELECT alto_tenant_rls_policies(%L, %L)', r.table_name, r.table_name IN ('ReleaseNote', 'LaborRuleSet')));
    tables := tables + 1;
  END LOOP;

  -- The platform agent switch (one row, the operator's) is read by every
  -- tenant's agents (lib/agentControls allAgentsSuspended).
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = '"AgentControl"'::regclass AND polname = 'platform_switch_read') THEN
    PERFORM pg_temp.alto_ddl('CREATE POLICY platform_switch_read ON "AgentControl" FOR SELECT USING (true)');
  END IF;

  -- The safety valve (see the header).
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid = '"User"'::regclass;
  SELECT string_agg(ro.rolname, ', ' ORDER BY ro.rolname) INTO readers
    FROM pg_roles ro
   WHERE ro.rolcanlogin
     AND NOT ro.rolsuper
     AND NOT ro.rolbypassrls
     AND ro.rolname NOT LIKE 'pg\_%'
     AND NOT pg_has_role(ro.oid, owner_oid, 'USAGE')
     AND has_table_privilege(ro.oid, '"User"'::regclass, 'SELECT');
  IF readers IS NOT NULL THEN
    RAISE WARNING 'tenancy rls: % tables have their policies, but row-level security was NOT enabled: the role(s) % can read the tables without owning them and would see no rows. Review docs/runbooks/tenancy-rls-cutover.md, then run SELECT alto_enable_all_tenant_rls(); as the owner.', tables, readers;
  ELSE
    PERFORM pg_temp.alto_ddl(format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t)) FROM alto_tenant_rls_tables() AS t;
    RAISE NOTICE 'tenancy rls: row-level security enabled (not forced) on % tables', tables;
  END IF;
END $$;
