-- Brief 2-1 §9.5 — the role the API connects as once the database wall is on.
--
-- Run ONCE, as the database owner (the role DIRECT_URL / migrations use),
-- against the production database. Not a migration: the deploy user may not
-- be allowed to create roles, and the password must never sit in the repo.
--
--   psql "$DIRECT_URL" -v app_password="$(openssl rand -base64 33)" -f apps/api/scripts/create-app-role.sql
--
-- In the Neon SQL editor (no psql variables): replace :'app_password' below
-- with the quoted password and drop the \set / \gset lines. Neon refuses a
-- password with less than 60 bits of entropy; the openssl line above is fine.
--
-- What alto_app can do: read and write rows (row-level security decides
-- which), use sequences, call functions. What it cannot: own or alter tables,
-- TRUNCATE, create roles, bypass row-level security, touch _prisma_migrations.
-- docs/runbooks/tenancy-rls-cutover.md is the full procedure and rollback.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alto_app') THEN
    CREATE ROLE alto_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;

-- psql does not expand variables inside a DO block, so the password is set here.
ALTER ROLE alto_app WITH LOGIN NOBYPASSRLS PASSWORD :'app_password';

SELECT current_database() AS app_db \gset
GRANT CONNECT ON DATABASE :"app_db" TO alto_app;
GRANT USAGE ON SCHEMA public TO alto_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO alto_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO alto_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO alto_app;
-- The migration ledger is the owner's.
REVOKE ALL ON TABLE public."_prisma_migrations" FROM alto_app;

-- Tables, sequences and functions that later migrations create (as this
-- owner) are granted the same way, so a deploy never meets "permission denied".
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO alto_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO alto_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO alto_app;

-- Checks. Expect: alto_app | f | f | f, then (tenant tables, tables enabled) equal and non-zero.
SELECT rolname, rolsuper, rolbypassrls, pg_has_role('alto_app', (SELECT relowner FROM pg_class WHERE oid = 'public."User"'::regclass), 'USAGE') AS owns_tables
  FROM pg_roles WHERE rolname = 'alto_app';
SELECT count(*) AS tenant_tables,
       count(*) FILTER (WHERE c.relrowsecurity) AS tables_enabled,
       count(*) FILTER (WHERE c.relforcerowsecurity) AS tables_forced
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace
   AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation');
