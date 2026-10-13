# SOC 2 controls in the product: investigation (Brief 2-5)

Investigation only (2026-10-13). No code, schema, migration or infrastructure was changed. Every "confirm" below is something the owner checks in a console; nothing here assumes what Railway, Neon or the storage provider does by default.

## 1. Summary

1. **Alto People already has about half of what a Type I auditor tests, but none of it produces evidence.** Field encryption (AES-256-GCM), an append-only audit log, sign-in lockout and rate limits, MFA, an access report, a nightly uploads backup job, and an encryption-key audit script all exist. None of them writes a dated, signed, retrievable record that a control ran and passed, which is what the audit consumes.
2. **The QuickBooks lesson is structural, not a one-off.** On 2026-06-11 the field-encryption key changed with no keyring, so every row written under the old key became unreadable: SSNs, bank accounts, TINs, I-9 numbers, kiosk numbers, QuickBooks tokens. The ciphertext format has a version byte but no key id, so the app cannot hold two keys. The same key also doubles as the HMAC secret for kiosk numbers, survey anonymity, bank-account fingerprints and (by fallback) MFA secrets, so rotating it today would break four other things silently.
3. **Backups are split across three providers and only one is configured in code.** The database is on Neon with point-in-time recovery (retention unconfirmed). Uploaded documents back up nightly only if four `BACKUP_S3_*` variables are set, and only when `STORAGE_DRIVER=local`. Nothing has ever tested a restore.
4. **Dependency scanning does not exist in CI.** There is no `npm audit` step, Dependabot or CodeQL. Known advisories are tracked in memory, not in the pipeline.
5. **Two gaps sit outside the brief's list but an auditor will find them.** Kiosk selfies and face templates (biometric data) are stored in Postgres unencrypted at the field level, and document blobs rely entirely on the provider's at-rest encryption, which nobody has confirmed.
6. **Recommendation:** build one evidence spine first (a `ComplianceEvidence` record, append-only, plus the evidence page), then fill it control by control, with the keyring and a proven rotation as the first real control because it is the one that has already cost data. Seven steps, about four weeks of build; the restore test and the rotation are the acceptance gates. Nine owner decisions in §8.

## 2. What exists

| Control area | What is there | Where | Evidence today |
|---|---|---|---|
| Field encryption at rest | AES-256-GCM, 12-byte IV, 16-byte tag, format `[version=1][iv][ct][tag]` | `apps/api/src/lib/crypto.ts:8`, `:33`, `:45` | None; no key id in the blob |
| Encrypted columns | `W4Submission.ssnEncrypted`, `Associate.tinEncrypted`, `PayoutMethod.accountNumberEnc`, `I9Verification.alienRegistrationNumberEnc`, `KioskPin.pinEncrypted`, `QuickbooksConnection.accessTokenEnc/refreshTokenEnc`, `User.mfaSecretEncrypted` | `prisma/schema.prisma:433, 1797, 2833, 2880, 2901, 4379, 6864` | Listed in `docs/access-cleanup-1a4.md` §"Written confirmation" |
| Not encrypted despite the name | `PayoutMethod.routingNumberEnc` holds plain bytes (routing numbers are public) | `schema.prisma:2896` | Documented in the schema comment |
| MFA key | `MFA_SECRET_ENCRYPTION_KEY`, falling back to the payout key when unset | `src/lib/mfaCrypto.ts:22` | Unknown whether production sets it |
| Payout key reused as an HMAC secret | kiosk PIN lookup (fallback when `KIOSK_PIN_SECRET` unset), pulse-survey responder hash (fallback when `PULSE_HASH_SECRET` unset), bank-account fingerprint (always) | `src/lib/kioskAuth.ts:39`, `src/routes/pulseSurveys109.ts:37`, `src/lib/financialChanges.ts:161` | None |
| Key audit | Counts rows the running key cannot read, by column, with date ranges; never prints plaintext | `scripts/audit-encryption-key.ts` | Run by hand; output not stored |
| Unreadable-row handling | QuickBooks answers 409 `quickbooks_reconnect_required` and offers Reconnect; other columns have re-collection paths | `docs/access-cleanup-1a4.md:44`, `:71` | — |
| In transit (web) | `helmet` with defaults (HSTS on), `trust proxy` behind Railway's edge | `src/app.ts:191`, `:289` | None |
| In transit (database) | Whatever `DATABASE_URL` says; nothing checks | `prisma/schema.prisma:14` | None |
| Blob storage | `STORAGE_DRIVER=local` (Railway volume) or `s3`; `PutObject` sets no server-side-encryption option | `src/lib/blobStore.ts:184`, `src/config/env.ts` (STORAGE_*) | None |
| Database backup | Neon point-in-time recovery, per `BACKUPS.md` | `apps/api/BACKUPS.md` "What it does NOT cover" | Retention unconfirmed ("may be as low as 24h") |
| Uploads backup | Nightly gzipped tar of the uploads disk to an S3-compatible bucket, 30-day retention, platform job | `src/lib/uploadsBackup.ts`, `:133`, `:156` | Boot log only; off unless four variables are set |
| Restore test | — | — | Never run |
| Access review (people) | Access report: personal-email portal logins, region scope, duplicate person, no employment record, employment ended, 90 days idle, deletion pending; CSV; prod script | `src/lib/accessCleanup.ts:55`, `:119`; `scripts/access-report.ts` | Run by hand; no sign-off record |
| Access review (agents) | Agent registry: scopes, gated actions, owner, credentials, spend, scorecard | `src/lib/agents*.ts`, `routes/agents.ts` | Not in the access report |
| Audit log | `AuditLog` append-only by database trigger (update and delete refused; truncate allowed for the test harness) | `prisma/migrations/20261107090000_agent_registry/migration.sql:93-115` | The trigger is the evidence; nothing reports it |
| Sign-in signals | Per-account lockout (`failedLoginCount`, `lockedUntil`), IP rate limits on login and MFA, `auth.login` / `auth.login_failed` / `auth.logout` / MFA / password audit rows | `src/routes/auth.ts:402-445`; `src/middleware/rateLimit.ts:22`, `:45`; `src/lib/audit.ts:191`, `:224` | Rows exist; no one is alerted |
| Privilege changes | `admin.user_updated` with `changes.role {from,to}` and the region approver, as a critical audit | `src/routes/users.ts:530-545` | Rows exist; no alert |
| Data exports | Audited on ten actions (`payroll.external_sheet_exported`, `document.bulk_exported`, `auth.data_exported`, …); 21 route files serve CSV or attachments | `grep "attachment; filename"` across `src/routes` | Partial: not every export writes a row |
| Dependency scanning | — | `.github/workflows/ci.yml` has no audit step; no `dependabot.yml`; no CodeQL | Advisories tracked in memory (`deployment-railway.md`) |
| Evidence page pattern | The Reliability page: one lib computes facts, a weekly row stores them, a page shows the streak | `src/lib/reliability.ts`, `src/routes/productAnalytics.ts:62`, `apps/web/src/pages/analytics/ReliabilityHome.tsx` | — |

## 3. Gaps

1. **No evidence record.** Controls run (or could) but leave no dated, immutable, retrievable result.
2. **No keyring.** One key at a time; a change strands every existing row (the 2026-06-11 loss). The blob has no key id.
3. **One key, five jobs.** The payout key encrypts fields and is also an HMAC secret in up to four places. A rotation must first give each job its own secret, set to the current value so nothing changes on the day.
4. **No restore has ever been tested**, for the database or the uploads.
5. **No dependency scanning or policy.**
6. **Signals without alerts.** Lockouts, failed-login bursts, role escalations and large exports are recorded and nobody hears about them.
7. **Exports not uniformly audited.** Some CSV and PDF routes write no audit row.
8. **Access review excludes agents** and has no sign-off.
9. **Unconfirmed provider facts:** Neon PITR retention and region, Neon TLS enforcement, the storage driver in production, at-rest encryption of the blob bucket and the Railway volume, whether `MFA_SECRET_ENCRYPTION_KEY`, `KIOSK_PIN_SECRET`, `PULSE_HASH_SECRET` and `BACKUP_S3_*` are set.
10. **Biometric data unencrypted at the field level** (`KioskPunch.selfie`, `KioskFaceReference.descriptor`, `schema.prisma:6891`, `:6950`). Outside the brief, inside an auditor's sampling, and a BIPA-style exposure in some states.

## 4. Design

### 4.1 The evidence spine (build first)

- `ComplianceEvidence { id, control, status PASS|FAIL|WARN, summary, details Json, artifactKey?, collectedAt, collectedBy (job name or userId), signedOffBy?, signedOffAt?, periodStart?, periodEnd? }`, append-only by the same trigger pattern as `AuditLog`. Platform-level: SOC 2 evidence belongs to Alto People as the service organization, not to a tenant (decision 1).
- `lib/evidence.ts`: `recordEvidence(control, result)`; each control is a function that returns `{status, summary, details}` and never throws.
- A control catalog in `packages/shared` (id, title, SOC 2 criterion, cadence, owner role, how it is collected), so the page, the jobs and the docs read one list.
- Evidence page at `/admin/compliance-evidence`: one row per control with the latest result, its age against the cadence (stale = red), a history drawer, and sign-off for the controls that need a human (access review, rotation). Read: `view:org`. Sign-off: `manage:org` (exec stays read-only, per the executive-portal rule).

### 4.2 Controls and how each produces evidence

| Control | SOC 2 | Collected by | Cadence | PASS means |
|---|---|---|---|---|
| Field encryption inventory | CC6.1 | Job: every encrypted column decrypts under the keyring (counts only, the audit script made a job) | Daily | 0 unreadable rows, or every unreadable row explained by a recorded incident |
| Keyring and rotation | CC6.1 | Rotation runbook run (dry run, then live), §4.3 | On rotation, at least yearly | Re-encrypted count = row count, 0 failures, old key retired |
| TLS to the web | CC6.7 | Job: HTTPS request to the public health URL; records TLS version, certificate expiry, HSTS header | Daily | TLS 1.2+, cert > 14 days, HSTS present |
| TLS to the database | CC6.7 | Job: `SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()` | Daily | `ssl = true` |
| Blob at-rest encryption | CC6.1 | Owner attestation (provider setting) + job: `HeadObject` reports server-side encryption when the provider exposes it | Quarterly + daily | Provider encryption on |
| Database backup | A1.2 | Nightly encrypted logical dump to the backup bucket with a row-count manifest (decision 3) + Neon PITR retention attested | Daily | Dump present, size within band, manifest written |
| Restore test | A1.2/A1.3 | Monthly job restores the newest dump into a scratch database and compares row counts to the manifest | Monthly | Every listed table matches |
| Uploads backup | A1.2 | The existing job writes evidence on each run | Daily | Archive uploaded |
| Access review | CC6.2, CC6.3 | Quarterly report: every account with an elevated role, every agent with its scopes, gates, owner, credential age and last use; flags from 1A-4; sign-off by a named approver | Quarterly | Signed off within 14 days, every flag resolved or accepted with a reason |
| Dependency scanning | CC7.1 | CI step `npm audit --omit=dev --audit-level=high` against an accepted-risk list; result posted as evidence | Every push to main + weekly | No unaccepted high or critical in production dependencies |
| Auth anomaly alerting | CC7.2 | Rules over audit rows: a lockout, ≥ 10 failed sign-ins from one IP in 15 minutes, MFA disabled on an admin; alert to the security contact | Continuous; daily evidence row of alerts sent | Every rule armed; alerts delivered |
| Privilege change alerting | CC6.3, CC7.2 | Rule: any role change to an admin-capable role, region scope granted, agent scope widened, a gated action approved | Continuous | Same |
| Export alerting | CC7.2 | Every export route writes an audit row (sweep); rule: exports above a row threshold or of sensitive kinds alert | Continuous | Same; a test proves every export route audits |
| Audit log immutability | CC7.2 | Job: attempts an UPDATE on a sentinel row inside a rolled-back transaction and expects the trigger's refusal | Daily | Refused |

### 4.3 The keyring and rotation (the QuickBooks lesson applied)

1. **Separate the jobs first, with no change in behaviour.** Set `KIOSK_PIN_SECRET`, `PULSE_HASH_SECRET`, a new `ACCOUNT_FINGERPRINT_SECRET` and `MFA_SECRET_ENCRYPTION_KEY` to the current payout key's value, and make each code path read only its own variable (no fallback in production; boot refuses if one is missing). From then on the field key rotates alone.
2. **Ciphertext v2 carries a key id:** `[version=2][keyId:u8][iv][ct][tag]`. Encrypt always writes v2 with the active key. Decrypt reads v1 with key id 0 (the current key) and v2 by its id.
3. **Keyring from the environment:** `FIELD_KEYS="1:<base64>,2:<base64>"` and `FIELD_KEY_ACTIVE=2`. Boot refuses a keyring that cannot decrypt a stored canary row (one `EncryptionCanary` row per key id, written at activation). That canary would have caught 2026-06-11 at deploy time instead of in production reads.
4. **Rotation runbook, scripted** (`scripts/rotate-field-key.ts`): add the new key to the ring (both readable); activate it (new writes use it); re-encrypt in batches of 500 per column inside transactions, verifying each row decrypts to the same plaintext before committing; `--dry-run` reports counts without writing; finish with the inventory control at 0 rows on the old key id; only then remove the old key. Evidence row at each stage.
5. **Proof of zero data loss:** an API test seeds every encrypted column, runs the rotation, and asserts every value round-trips and no v1 or old-id blob remains; a second test proves a missing key fails at boot, not at read.
6. HMAC secrets (kiosk PIN, survey hash, fingerprint) are rotated by their own runbooks because a new secret changes every lookup value; kiosk numbers already have a re-HMAC path (`routes/kiosk99.ts:483`).

### 4.4 Backups and the restore test

Neon PITR stays the primary recovery. The daily logical dump is the off-provider copy that the restore test can exercise without touching production: a scheduled job runs `pg_dump --format=custom`, encrypts it with a backup key that lives outside the app (`age` or AES-256 with `BACKUP_ENCRYPTION_KEY`), uploads it to the backup bucket with a manifest of row counts per table taken in the same snapshot, and writes evidence. The monthly restore test downloads the newest dump, decrypts, restores into a scratch Postgres, recounts, compares to the manifest and writes PASS or FAIL. Where it runs is decision 3: GitHub Actions already runs a Postgres service container for the API tests and has `pg_dump`/`pg_restore`, which makes it the cheapest scratch database; the cost is a production read-only credential in GitHub secrets.

### 4.5 Alerting

Alerts are notifications to a named security contact (OrgSetting gains `securityContactEmail`; until 2-3 there is no platform-operator role), in-app plus email, rate-limited per rule, each delivery an audit row. Rules run as a platform job every five minutes over new audit rows, so no request path slows down. Finance never receives them (the handoff-spine rule against `notifyAllAdmins`).

## 5. Rollout

| Step | Content | Size |
|---|---|---|
| 1. Evidence spine | `ComplianceEvidence` (append-only), control catalog, `recordEvidence`, the evidence page with stale-control colouring and sign-off | 4 days |
| 2. Secrets split | Own variable per HMAC job, boot refusal without them, set in Railway to today's values (no behaviour change); test | 2 days |
| 3. Keyring + rotation | v2 ciphertext with key id, keyring, canary, rotation script with dry run, zero-loss test, first live rotation in production with evidence | 5 days |
| 4. Encryption and TLS evidence | Daily inventory job (the audit script as a job), TLS web and database checks, blob encryption check + attestation, audit-log immutability probe | 2 days |
| 5. Backups + restore test | Encrypted daily dump with manifest, monthly restore test, uploads backup writing evidence, the first passing restore | 4 days |
| 6. Access review | Quarterly report adding agents (scopes, gates, owner, credential age, last use) to the 1A-4 flags, sign-off flow, evidence | 3 days |
| 7. Scanning + alerting | CI audit step with accepted-risk list posting evidence; export-route audit sweep with a test; the alert rules and the security contact | 4 days |

About four weeks. Steps 1 and 2 can start at once; step 3 depends on step 2; step 5 depends on decision 3.

## 6. Acceptance mapping

| Acceptance line | Met by |
|---|---|
| A restore test passes and is logged | Step 5: the monthly job's first run, PASS with per-table counts, visible on the evidence page |
| A key rotation completes with no data loss | Step 3: the zero-loss API test in CI, then the production rotation with the inventory control at 0 unreadable rows before and after |
| The evidence page shows current evidence for every control listed | Step 1 + each step's job; the page marks any control without fresh evidence, so "every control current" is visible at a glance |

## 7. Risks

1. **The first live rotation touches every SSN, bank account and TIN.** Mitigated by the dry run, per-row verify-before-commit, the canary at boot, the old key kept readable until the inventory reads zero, and a production backup taken immediately before.
2. **A dump in an S3 bucket is a full copy of PII.** It is encrypted with a key that is not in the app or the bucket's account; the bucket is write-only for the job's credential and read-only for the restore credential; retention is short (decision 4).
3. **A production database credential in GitHub** (if decision 3 picks Actions): read-only role, IP allowlisting where Neon supports it, rotated quarterly with evidence.
4. **Alert noise.** Thresholds start conservative and every rule has a per-hour cap; noise is tuned from the first two weeks' evidence rows.
5. **"Evidence" that is self-reported.** Attestations (provider settings) are marked as such on the page, with who attested and when, so the auditor sees which controls are measured and which are declared.
6. **Tenancy.** Evidence is platform-level; per-tenant access reviews use the tenant filter added in the 2-1 leak work (`buildAccessReport(db, now, { tenantId })`), so one customer never sees another's accounts.

## 8. Owner decisions

1. **Evidence is platform-level** (Alto People as the service organization), with per-tenant access reviews generated for each customer to sign. Recommendation: yes.
2. **Separate secrets for every HMAC job and for MFA, set to today's key value**, with boot refusing to start without them. Recommendation: yes; it is the precondition for any safe rotation.
3. **Where the daily dump and the monthly restore run:** GitHub Actions (has `pg_dump` and a scratch Postgres; needs a read-only production credential in GitHub secrets), or a Railway cron service (credential stays in Railway; needs a scratch database provisioned). Recommendation: GitHub Actions with a read-only role, because the scratch database is free and isolated per run.
4. **Backup retention:** 35 daily dumps plus 12 monthly. Recommendation: yes; long enough for the monthly test and a quarter's look-back, short enough to limit the PII copy.
5. **Accepted-risk list for dependency scanning** starts with the advisories already judged (exceljs/uuid, `deepmerge-ts` via the Prisma CLI, dev-only), each with a review date. Recommendation: yes; anything new and high blocks the merge.
6. **Security contact:** one named person and mailbox receives every security alert until 2-3 brings a platform-operator role. Recommendation: the owner's address now.
7. **Encrypt kiosk selfies and face templates at the field level** under the new keyring, and set a retention for selfies. Recommendation: yes, in step 3, with a selfie retention of 90 days (outside the brief, but an auditor will sample it).
8. **First production rotation inside the acceptance window**, scheduled at a quiet hour with the backup taken just before. Recommendation: yes; the acceptance line needs a real rotation, not only the test.
9. **Provider confirmations the owner makes in the consoles** (§3 gap 9): Neon PITR retention and region, TLS enforcement, the production storage driver and bucket encryption, which of the secret variables are set. Recommendation: done before step 3; each becomes an attested evidence row.

## 9. Sources in the repo

`apps/api/src/lib/crypto.ts`, `src/lib/mfaCrypto.ts`, `src/lib/kioskAuth.ts`, `src/lib/financialChanges.ts`, `src/routes/pulseSurveys109.ts`, `src/routes/kiosk99.ts:483`, `scripts/audit-encryption-key.ts`, `src/lib/accessCleanup.ts`, `scripts/access-report.ts`, `src/lib/uploadsBackup.ts`, `apps/api/BACKUPS.md`, `src/lib/blobStore.ts`, `src/app.ts`, `src/routes/auth.ts`, `src/middleware/rateLimit.ts`, `src/lib/audit.ts`, `src/routes/users.ts`, `prisma/migrations/20261107090000_agent_registry/migration.sql`, `src/lib/reliability.ts`, `.github/workflows/ci.yml`, `railway.json`, `docs/access-cleanup-1a4.md`.

## Owner approval

**Approved 2026-10-13: every decision in this report, as recommended.** Building proceeds step by step in the order of the plan; each step lands with its tests and is reported before the next.
