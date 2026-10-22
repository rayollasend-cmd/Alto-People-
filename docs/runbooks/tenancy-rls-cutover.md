# Runbook: turning on the database wall (tenancy row-level security)

Brief 2-1, §9.5 and §9.7 step 4 (`docs/multi-tenancy-investigation.md`). Today the only thing keeping one tenant's rows from another is the application (the tenant guard in `lib/tenantGuard.ts`, `TENANCY_MODE=enforce`). This runbook puts Postgres behind it: once done, a query that forgets its tenant, a raw SQL statement or a script bug cannot read or write another tenant's rows, because the database refuses.

Nothing in this runbook happens on a deploy. Each step is the owner's, in order, and each has its own rollback.

## What the deploy already did

| Migration | Effect on production |
|---|---|
| `20270128190000_tenancy_required` (migration C) | `tenantId` is NOT NULL on every tenant table (NULLs, if any, were filled with Alto HR first; the column default stays). The keys that were unique for the one employer are unique per tenant: associate and candidate email, the kiosk employee number, sponsor, skill, asset, worktag, decision and relay keys, attestation and source-spend keys, workers' comp class codes, the filed 941/940 index, the company-wide timesheet filing, help articles and holidays. The four settings singletons are one row per tenant (Alto HR keeps its row and id). Pay-check numbers come from a per-tenant counter (`TenantCounter`), seeded from the last number issued, so the next check carries on from today's number. `User.email` and `JobPosting.slug` stay platform-wide. |
| `20270128190100_tenancy_rls` (deploy D) | A `tenant_isolation` and a `platform_scope` policy on every tenant table, and row-level security ENABLED (not forced). The table owner bypasses a policy that is not forced, and the app connects as the owner, so nothing changes until step 3 below. |

`TENANCY_RLS` (API env, default `off`) decides whether the app tells Postgres its tenant on every query (`lib/tenantRls.ts`): a statement outside a transaction becomes a two-statement batch (`set_config`, then the statement); a transaction sets it once, as its first statement. `set_config(..., true)` lasts one transaction, so it is safe behind Neon's transaction-mode pooler.

### First, check what the migration did

As the owner (`DIRECT_URL`), in the Neon SQL editor or psql:

```sql
SELECT count(*) FILTER (WHERE relrowsecurity) AS enabled,
       count(*) FILTER (WHERE relforcerowsecurity) AS forced
  FROM pg_class c
 WHERE relnamespace = 'public'::regnamespace
   AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation');
```

- `enabled` around 480, `forced` 0: the normal case. Go on.
- `enabled` 0: the migration found a login role that can read the tables without owning them (its WARNING named it; Railway's pre-deploy log has it), and left the policies off rather than hide every row from that role. Usually this is the backup role (`BACKUP_DATABASE_URL`, `.github/workflows/backup.yml`). Give it `BYPASSRLS` (a backup must see every tenant), check nothing else connects as such a role, then: `SELECT alto_enable_all_tenant_rls();`

```sql
-- the backup role (name as created for BACKUP_DATABASE_URL)
ALTER ROLE <backup_role> BYPASSRLS;
```

Without `BYPASSRLS`, `pg_dump` as a non-owner fails loudly once the wall is on ("query would be affected by row-level security policy"), which the backup job reports. It never writes an empty dump.

## Step 1 (optional soak): the flag alone

In Railway, API service, production: add `TENANCY_RLS=on`. Redeploy.

Still the owner connection, so every row stays visible; the only change is one extra statement per query. Watch for a day: p95 latency on the busiest routes (Reliability page), error rate in Sentry. Nothing should change but a few milliseconds.

Rollback: remove the variable, redeploy.

## Step 2: create the role

Once, as the owner:

```bash
psql "$DIRECT_URL" -v app_password="$(openssl rand -base64 33)" -f apps/api/scripts/create-app-role.sql
```

Keep the generated password in the password manager; it goes into Railway in step 4 and nowhere else. The script ends with two checks: `alto_app | f | f | f` (not a superuser, no bypass, does not own the tables) and the table counts from the check above.

Neon: running it from the SQL editor works too (replace `:'app_password'` by hand, as the script's header says). The role appears under Roles in the Neon console; it does not need to be created there.

## Step 3: prove the wall before switching

Connect AS `alto_app` (the direct host, `alto_app:<password>@…`):

```sql
SELECT count(*) FROM "User";                                   -- 0: no tenant, no rows
BEGIN;
SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true);
SELECT count(*) FROM "User";                                   -- Alto HR's real count
COMMIT;
SELECT count(*) FROM "User";                                   -- 0 again: the setting ended with the transaction
```

All three must hold. If the middle one is 0, the policies are not what this runbook expects: stop.

## Step 4: switch the API to the role

In Railway, API service, production:

1. `DATABASE_URL` = the **pooled** connection string with `alto_app` and its password (same host and database as today).
2. `DIRECT_URL` = unchanged (the owner). `prisma migrate deploy` runs with it, so migrations keep running as the owner.
3. `TENANCY_RLS=on` (if step 1 was skipped).

Redeploy. Then, within ten minutes:

- Sign in as an HR admin; open People, Schedule, Time, a payroll run, the client portal as a portal user.
- Punch on a kiosk (or the kiosk test page).
- Logs: no `row-level security` errors, no `ran with no tenant in context`. A list that is suddenly empty is the symptom of a query that ran without its tenant.
- The next timed jobs (shift reminders, digests, sweeps) log their usual lines. Every job runs per tenant (`runForEachTenant`) or under the audited platform scope (`platformJob`), so each one tells the database whose rows it touches.

## Rollback

From fastest to slowest; none changes data.

1. **Switch back to the owner:** `DATABASE_URL` = the previous (owner) connection string, redeploy or restart. The owner bypasses the policies, so the wall is down while the policies stay in place. `TENANCY_RLS` can stay `on`.
2. **Emergency, from the database itself** (if a redeploy is not possible): as the owner, `SELECT alto_disable_all_tenant_rls();` — every role sees every row again, instantly. Re-arm later with `SELECT alto_enable_all_tenant_rls();`.
3. Never set `TENANCY_RLS=off` while connected as `alto_app`: with no tenant set the role sees no rows at all.

## What keeps connecting as the owner

- Migrations (`DIRECT_URL`, the Railway pre-deploy `prisma migrate deploy`).
- `prisma/seed.ts` and every one-off script under `apps/api/scripts/` — they use a plain client with no tenant context, so as `alto_app` they would read nothing.
- The backup and restore jobs (their own role, with `BYPASSRLS`, see above).
- The API test suite. `src/__tests__/tenancy/rlsWall.test.ts` is the proof: it creates a non-owner role in the test database, connects as it with `TENANCY_RLS=on` and the application wall switched off, and shows tenant two cannot read, change, delete or plant tenant one's rows (models, transactions, batches and raw SQL), that the audited platform scope sees both, and that a statement with no tenant sees nothing.

## Adding a tenant table later

A migration that creates a tenant-keyed table adds, after the `CREATE TABLE`:

```sql
SELECT alto_tenant_rls_policies('NewTable');
ALTER TABLE "NewTable" ENABLE ROW LEVEL SECURITY;
```

`rlsWall.test.ts` fails until it does. `alto_app` gets the table through the default privileges the role script set; nothing else to grant.

## Not in this step

- `FORCE ROW LEVEL SECURITY` (walling the owner too) needs migrations to run as a separate role first. Later, if ever.
- A platform operator's cross-tenant read goes through `withPlatformScope`, which writes a `platform.scope_opened` audit row every time it opens, and sets `app.platform_scope` for the database.
