# One-off scripts: what each is for, and whether a deploy needs it

Every script under `apps/api/scripts/` that is not wired into `package.json` or a
GitHub workflow, with its purpose, whether it must run on a deploy, and the last
run we can account for. "Unknown" means no doc, OpsRun row or commit message
records a run; treat the script as not yet run on that environment until someone
writes the date here.

Run from `apps/api` unless the command says otherwise. Against production use
`railway run --service api -- npx tsx scripts/<name>.ts`.

Legend for **On deploy**: **yes** = part of the deploy sequence until this note
says otherwise · **once** = run one time after the migration it names, then never
again (idempotent, safe to re-run) · **no** = diagnostic, gate, or environment
setup; never part of a deploy.

## Backfills a deploy depends on

| Script | Purpose | On deploy | Last known run | Command |
|---|---|---|---|---|
| **`backfill-deduction-lines.ts`** | Writes `PayrollItemDeduction` rows for paychecks cut before itemizing (migration `20270116100000_payroll_item_deduction`). Idempotent: touches only items with no lines. Since 2026-10-21 the paystub derives the same lines in memory (`lib/deductionBackfill.ts`) when a check has none, so a stub reads right either way; the rows are still needed for year-to-date per line in the ledger and the W-2 wage bases to be queryable. | **once** (after the 2027-01-16 migration; dry run first) | Unknown on prod. Dev: unknown. | `npx tsx scripts/backfill-deduction-lines.ts` (dry run) then `--apply [--year 2026]` |
| **`cleanup-misrouted-notifications.ts`** | Marks read the unread admin notifications that `CATEGORY_ROLE_ROUTING` no longer sends to a role (lib/notificationRoutingCleanup.ts). Dry run by default. | **once** (after the 2026-10-21 notification-routing change) | Not run anywhere (the script landed uncommitted on 2026-10-21). | `npx tsx scripts/cleanup-misrouted-notifications.ts` then `--apply` |
| **`backfill-ride-places.ts`** | Geocodes saved ride addresses that have no pin (text-only places from before the pickup picker, Sep 2026). Needs the geocoder (`MAPBOX_TOKEN` in prod). | **once** (after the Sep 2026 pickup-picker deploy) | Unknown. | `npx tsx scripts/backfill-ride-places.ts [--dry]` |
| `ensure-internal-hires-client.ts` | Creates the "Alto HR — Internal Hires" synthetic client on a fresh deployment; creates no users. Idempotent. | **once** per new environment | Prod: assumed (the client exists); dev: seed covers it. | `npx tsx scripts/ensure-internal-hires-client.ts` |
| `migrate-blobs-to-s3.ts` | Copies every local blob under `UPLOAD_DIR` to the S3 bucket before `STORAGE_DRIVER=s3` is switched on (see `apps/api/STORAGE.md`). | **once**, before the storage-driver switch | Not needed until the switch; unknown. | `npx tsx apps/api/scripts/migrate-blobs-to-s3.ts` (from the repo root) |
| `sop-temperature-types.ts` | Retypes freezer-check SOP tasks saved as CHECK/NUMBER to TEMPERATURE so the tablet keypad gets a minus and the range alert works. | **once** | Unknown. | `npx tsx scripts/sop-temperature-types.ts [--apply]` |
| `release-inactive-shifts.ts` | Takes deactivated and separated associates off every shift still ahead of them (the code now does this on both paths; this catches the rows from before). | **once** | Unknown. | `npx tsx scripts/release-inactive-shifts.ts [--apply]` |
| `soft-delete-empty-policies.ts` | Soft-deletes required-for-onboarding policies with no body (un-acknowledgeable; stranded associates at N-1). | **once** (reported case 2026-05-02) | Unknown. | `npx tsx scripts/soft-delete-empty-policies.ts [--apply]` |
| `swap-standard-template.ts` | Replaces the global STANDARD onboarding template in a target DB with the source DB's, preserving UUIDs. Two database URLs via env. | **no** (manual, reviewed) | Unknown. | `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npx tsx scripts/swap-standard-template.ts` |
| `transfer-config-to-prod.ts` | Copies dictionary/definition rows from a source Neon branch to a target; never people, PII or audit history. | **no** (manual, reviewed) | Unknown. | `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npx tsx scripts/transfer-config-to-prod.ts` |
| `consolidate-walmart.sql` + `run-consolidation.ts` | May 2026: folded four Walmart client rows into one client with four locations (after migration `20260510000000_locations_and_assignments`). Environment-specific. | **no** (done; archive) | May 2026 on the then-production branch (commit history). | `npx tsx scripts/run-consolidation.ts` |
| `wipe-and-bootstrap.ts` | DESTRUCTIVE: truncates every business table in the database named by `WIPE_DATABASE_URL` and creates one bootstrap HR admin. For emptying a branch before customer onboarding. | **no** (never on a deploy) | Unknown. | `WIPE_DATABASE_URL=… npx tsx scripts/wipe-and-bootstrap.ts` |

## Gates and evidence (run by hand, on a schedule or before a sign-off)

| Script | Purpose | On deploy | Last known run | Command |
|---|---|---|---|---|
| `rotate-field-key.ts` | Field-encryption key rotation: dry run, `--live` re-encrypt under `FIELD_KEY_ACTIVE`, `--retire <id>` once the inventory is zero. Writes `keyring-rotation` evidence. | **no** (a planned rotation) | Never run in production (docs/system-audit-2026-10-21.md §3). | `npx tsx scripts/rotate-field-key.ts [--live] [--retire N]` |
| `audit-encryption-key.ts` | Which encrypted rows the current key can still read (the 2026-06-11 incident's inventory). | **no** (diagnostic; quarterly) | 2026-06 after the incident (docs/access-cleanup-1a4.md). | `npx tsx scripts/audit-encryption-key.ts` |
| `access-report.ts` | The access report: counts and flagged accounts; `--persist` records SOC 2 evidence. | **no** (quarterly) | Unknown. | `npx tsx scripts/access-report.ts [--csv] [--persist]` |
| `labor-dry-run.ts` | Brief 2-2 gate: recomputes every finalized run through the labor-rules engine, read-only; the owner signs the diff before pay moves to the engine. | **no** (gate) | Not signed (audit 2026-10-21). | `npx tsx scripts/labor-dry-run.ts [--since YYYY-MM-DD] [--out path.csv]` |
| `labor-golden.ts` | Writes or checks the golden file of today's pay engine output. | **no** (CI reads the golden) | At the golden's capture (src/__tests__/laborRules). | `npx tsx scripts/labor-golden.ts [--write]` |
| `labor-packs-sql.ts` | Prints the INSERTs that seed the labor-rule packs for a migration. | **no** (when a pack changes) | At each pack migration. | `npx tsx scripts/labor-packs-sql.ts [JURISDICTION…]` |
| `daily-ot-lookback.ts` | Brief 2-2 step 0: daily-overtime look-back over paid periods, read-only. | **no** (gate) | Unknown. | `npx tsx scripts/daily-ot-lookback.ts [--since …] [--out …]` |
| `reconcile-payroll.ts` | Brief 1A-1: platform vs payroll-provider reconciliation for one period. Runs on placeholder export headers until the Synchros column map arrives. | **no** (gate; blocked) | Not run (placeholder headers). | `npx tsx scripts/reconcile-payroll.ts …` |
| `forecast-backtest.ts` | Brief 3-4 back-test of the demand forecast against the database. | **no** | Unknown. | `npx tsx scripts/forecast-backtest.ts [--tenant <id>] [--lead 4]` |
| `gen-tenant-columns.ts` | Brief 2-1 step one: generated the nullable `tenantId` columns and their migration. | **no** (done) | At migration `20261222100200_tenant_id_step_one`. | `npx tsx scripts/gen-tenant-columns.ts` |
| `prune-tenant-baseline.ts` | Shrinks `crossTenant.baseline.json` from a CI log (never adds). | **no** (when a leak is fixed) | 2026-10-14 (baseline header). | `npx tsx scripts/prune-tenant-baseline.ts <ci-log>` |
| `sample-efile.ts` | Sample EFW2/EFW2C/IRS FIRE files for the official validators (AccuWage, FIRE test system). | **no** | Never uploaded to the validators (audit). | `npx tsx scripts/sample-efile.ts` |
| `sample-integration.ts` | The public-API sample a customer would write; CI runs it against a test server. | **no** (CI) | Every CI run. | see header |
| `whatsapp-templates-export.ts` | The WhatsApp templates as Meta needs them for registration. | **no** (when templates change) | Unknown; templates not registered (audit). | `npx tsx scripts/whatsapp-templates-export.ts [--json]` |

## Diagnostics and reviews (read-only unless noted)

| Script | Purpose | On deploy | Last known run | Command |
|---|---|---|---|---|
| `audit-break-overpayment.sql` | Aug 2026 P0: re-derives break hours per disbursed item to size the overpayment before PR #289. | **no** (done; archive) | Aug 2026. | `psql … -f scripts/audit-break-overpayment.sql` |
| `audit-drawer-actions.ts` | 2026-09-25 review: E-Verify and e-sign actions taken while the drawers could show the wrong record. | **no** (done; archive) | 2026-09-25. | `npx tsx scripts/audit-drawer-actions.ts` |
| `quota-window-triage.ts` | Who did not get their email during the provider quota block, flow by flow. | **no** (done; archive) | At the quota incident (Sep 2026). | `npx tsx scripts/quota-window-triage.ts` |
| `financial-changes-last-60-days.ts` | Every bank, pay-card, W-4, SSN/TIN, name and address change in the last N days. | **no** | Unknown. | `npx tsx scripts/financial-changes-last-60-days.ts [days]` |
| `slowest-routes.ts` | p95 per route from `RouteUsageDaily`. | **no** | Unknown. | `npx tsx scripts/slowest-routes.ts [days] [minRequests]` |
| `count-templates.ts` | Counts onboarding templates (dev check). | **no** | Unknown. | `npx tsx scripts/count-templates.ts` |
| `reset-admin-password.ts` | Resets one admin's password from the command line (break-glass). | **no** | Unknown. | `npx tsx scripts/reset-admin-password.ts <email>` |
| `import-postings.ts` (+ `import-postings.data.json`) | Imports the job postings in the JSON into a tenant. | **once** per environment that wants them | Unknown. | `npx tsx scripts/import-postings.ts` |
| `email-preview.mts`, `email-size-audit.mts`, `email-test-send.mts` | Render templates to files, measure them, send a sample through Resend. | **no** | Unknown. | see headers |
| `seed-demo.ts`, `seed-demo-shifts.ts` | The populated demo tenant and the seeded associate's schedule. In `package.json` (`seed:demo`) and the design-walk workflow. | **no** (dev/demo only) | Every design walk. | `npm run seed:demo` |
| `db-backup.ts`, `db-restore-test.ts`, `failover/`, `load/` | Backup, restore test, failover probe, load harness. Run by `.github/workflows/backup.yml`, `failover-test.yml`, `load-test.yml`. | **no** (workflows) | Per workflow schedule; evidence posts only when `EVIDENCE_INGEST_*` is set. | see workflows |

## Keeping this record

When you run a one-off against an environment, add the date and the environment
to its "Last known run" cell in the same commit as the deploy notes. A script that
has run everywhere it ever needs to is marked "done; archive" and can move to
`scripts/archive/` in a later cleanup.
