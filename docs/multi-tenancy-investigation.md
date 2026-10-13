# Brief 2-1 — Multi-tenancy: investigation and isolation strategy

Date: 2026-10-13. Status: report before coding, as the brief requires. Nothing in this document changes data or code.

Alto People serves one employer today. A **tenant** will be one customer organization that runs its own workforce on the platform: its own people, stores, settings, branding and agents. `Client` stays what it is now, a customer store account *of* a tenant (Walmart 1234 is a Client of the Alto HR tenant), and `Location` stays a site under a Client.

## 1. Summary

- **268 models, 184 enums, 250 migrations.** 69 models carry a `clientId`, 22 a `locationId`, 132 reach a User or Associate through some foreign key, and **95 models have no required foreign-key path to Client, Location, User or Associate at all.** Those 95 are where tenancy has to be added by hand; everything else can derive its tenant from its parent, but will still get its own column so the database policy can see it without a join.
- **Five singletons and about forty "null client means company-wide" tables** encode "there is one employer". Each singleton becomes one row per tenant; each nullable `clientId` keeps its meaning (tenant-wide default) under a required `tenantId`.
- **36 unique constraints are unique per employer, not per tenant** (user and associate email, kiosk employee numbers, pay-check numbers, sponsor names, decision keys, filed tax forms). Two latent bugs surfaced on the way: the per-client kiosk-pin indexes were probably never dropped (the drop targeted the wrong names), and the filed-941 uniqueness would collide across tenants.
- **The application reads the tenant from nowhere today.** Sessions, API keys, agent credentials, kiosk devices, webhooks and public pages all resolve to the one employer by default. Each needs a tenant resolution rule (§6).
- **Background jobs, in-memory caches, blob keys and browser caches are all keyed without a tenant** (§5, §7, §8).
- **Recommended strategy (§9):** `tenantId` on every row, injected and enforced by a Prisma client extension driven by request context, plus PostgreSQL row-level security as the backstop with the tenant set per transaction. Alto HR becomes tenant 1 by an additive migration that backfills a constant. Rolled out in six steps, each shippable on its own, with a cross-tenant test suite that attempts every endpoint and every job from a second tenant.

## 2. Schema inventory

Counts come from greps over `apps/api/prisma/schema.prisma` (9,114 lines).

| Measure | Count |
|---|---|
| Models | 268 |
| Enums | 184 |
| Models with a `clientId` column | 69 |
| Models with a `locationId` column | 22 (8 with `locationId` only: StaffingTarget, AssociateAssignment, StoreShiftSop, SupervisorShiftWindow, Ride, EmergencySite, SeasonPlanSite, WorkerAssignment) |
| Models with no client/location column but a foreign key to User or Associate | 132 |
| Models whose only foreign keys go to other non-root models | 34 |
| Models with no foreign key at all | 25 |
| Models with **no required path** to Client, Location, User or Associate | **95** |

Three models link to a client or location under another name: `PulseSurvey.audienceClientId`, `Program.petitionClientId`, `Emergency.destinationLocationId`. Eleven models carry a denormalized `clientId` with no foreign key, left there "for future RLS": AttendanceEvent, SchedulingRosterOrder, ClockInRequest, PolicyAcknowledgment, DocumentRecord, BackgroundCheck, DrugTest, TimeEntry, AuditLog, TimesheetFiling, PacketDownload.

### 2.1 Singletons and org-wide configuration

| Model | Today | Under tenancy |
|---|---|---|
| `OrgSetting` (id `singleton`, DB CHECK) | The branding and org identity: `orgName` defaults to "Alto HR", sender name, support email, primary color, logo bytes, mileage rate, MFA requirement, finance mailbox, payout policy | One row per tenant; `tenantId` becomes the key; the CHECK constraint is dropped. This *is* the branding table the brief asks for; it gains plan and feature flags. |
| `SubmitterProfile` (singleton) | Employer identity for filings: EIN, SSA BSO id, IRS TCC, deposit schedule | One per tenant |
| `ProgramAlertSetting` (singleton) | Program alert lead days | One per tenant |
| `AgentControl` (singleton) | Global agent kill switch | One per tenant; a platform-level switch stays as well |
| `TransportSettings` (id `default`) | Fares, cutoff, dispatch phone | One per tenant |
| `PayrollConfig` (`year` unique) | IRS brackets and wage bases | **Stays global** (reference data) |
| `LocalTaxRule`, `WcClassCode` | Tax and workers'-comp reference | Global reference, or per tenant if rates differ by employer (decision in §10) |
| `ExecTarget` (`quarter` unique) | Org quarterly targets | Per tenant |
| `PayrollSchedule`, `VtoPolicy`, `Holiday`, and 13 template tables (Policy, OnboardingTemplate, ShiftTemplate, CustomFieldDefinition, DocumentTemplate, InterviewKit, JobPosting, Course, LearningPath, KbArticle, CareerLadder, WorkflowDefinition, Qualification) | `clientId` null means "company-wide default" | Keep the null meaning, add required `tenantId` |
| Employer facts kept on `Client` | `legalName`, `ein`, address, `sutaRateOverride`, `weekStartsOn` are used on W-2s | These are tenant facts stored on the customer row; move to `OrgSetting`/`SubmitterProfile` or keep per client by decision (§10) |

There is no feature-flag table, no workweek setting table (the workweek is `Client.weekStartsOn` plus hard-coded Saturday logic in code), and no separate Branding model.

### 2.2 The 95 models with no required tenant path

Because there is one employer, **every backfill is a constant** (`SET "tenantId" = <Alto tenant id>`). The grouping decides what the runtime rule is after the backfill.

- **Platform telemetry, keep global or nullable tenant:** ApiBoot, RouteUsageDaily, WebVitalDaily, ReliabilityWeek, GeoCache, PayrollConfig, ReleaseNote, ResendWebhookEvent, BranchWebhookEvent, WebAuthnChallenge, IdempotencyRecord.
- **Tenant configuration and catalogs, required tenant, constant backfill:** the five singletons; ExecTarget, ExecDecisionState, ClientProspect, Region, Sponsor, Skill, Asset, WorktagCategory, Worktag, WcClassCode, LocalTaxRule, TransportStop, EmailSuppression, RecruitingSourceSpend, Van.
- **Nullable `clientId`, derive from the client when set:** the template and policy tables above; PayrollRun; Broadcast, Survey (+ questions, responses, answers), PulseSurvey (+ responses), Cohort, SeasonPlan, ComplianceScoreSnapshot; Conversation and Message (derive from creator or participants); ApiKey (from `createdById`) and Webhook (+ deliveries); SchedulingRosterOrder and TimesheetFiling (join Client).
- **Actor-only rows with every foreign key optional:** AuditLog (actor and client optional; the append-only trigger must be extended to cover the new column after the backfill), Notification (email and SMS rows may have no user), WhatsAppMessage (inbound from unknown numbers), Emergency, AnonymousReport (+ updates), Candidate (+ events), WorkNote, RelayFile, DecisionNextStep, ComplianceActionState, Report (+ schedules), OpsSopTemplate (+ tasks), WorktagAssignment, TaxForm (941/940 rows have no associate), TaxDeposit, GarnishmentRemittance.
- **The roots:** `User.clientId` is null for every internal account, and `Associate` has no client column at all. Both get their own required `tenantId`. Every other people table derives from them.

### 2.3 Unique constraints that break under tenancy

Become `@@unique([tenantId, …])`:

| Constraint | Note |
|---|---|
| `User.email` | Login looks the account up by email before any tenant is known. Decision: keep email globally unique (one account can belong to one tenant), or resolve the tenant first from the host name. Recommendation in §9.4. |
| `Associate.email`, `Candidate.email` | Per tenant |
| `KioskPin.pinHmac` | The four-digit employee number is company-wide today. **Latent drift:** `KioskPin_clientId_associateId_unique` and `KioskPin_clientId_pinHmac_unique` (migration 20260427210000) were "dropped" by 20260427510000 under `…_key` names that never existed, so the per-client indexes are probably still in production. Verify with `\d "KioskPin"` before 2-1 touches the table. |
| `PayCheck.checkNumber` (autoincrement) | One global sequence; becomes a per-tenant counter |
| `ClientStatement.number` | Assigned org-wide sequentially (no DB unique) |
| `JobPosting.slug` | Public URL; may stay global if careers pages are per host |
| `Sponsor.name`, `Skill` lower(name), `Asset [kind, serial]`, `WorktagCategory.key` | Per tenant |
| `ExecTarget.quarter`, `ExecDecisionState.key`, `DecisionClaim.key`, `DecisionNextStep.key`, `RelayClaim [subjectType, subjectKey]`, `ComplianceActionState.actionKey`, `ManualComplianceAttestation [key, periodStart]`, `RecruitingSourceSpend [source, month]` | Generated keys collide across tenants |
| `TimesheetFiling [weekStart, clientId]` + partial null-client index, `ComplianceScoreSnapshot [day, clientId]`, `OnboardingTemplate [clientId, track]`, `VtoPolicy.clientId`, the SQL partial indexes `CustomFieldDefinition_global_key_unique`, `Holiday_client_date_name_key`, `KbArticle_client_slug_key` | All encode "null client = the one company"; each gains `tenantId` |
| `TaxForm_unique_filed` (SQL partial) | Two tenants' filed 941 or 940 for the same quarter collide today |
| `AgentProfile.builtInKey` | Each tenant gets its own built-in agents |
| `WcClassCode [stateCode, code, effectiveFrom]` | Only if rates become per employer |
| The five singleton primary keys | Become unique per tenant |

Stay global: secrets and provider ids (`InviteToken.tokenHash`, `PasswordResetToken.tokenHash`, `MfaRecoveryCode.codeHash`, `EmailChangeRequest.tokenHash`, `WebAuthnCredential.credentialId`, `PushSubscription.endpoint`, `Offer.acceptTokenHash`, `AgentCredential.tokenHash`, `AnonymousReport.trackingCode`, `KioskPunch.idempotencyKey`, `BranchWebhookEvent.branchEventId`, `ResendWebhookEvent.svixId`, `WhatsAppMessage.waMessageId`), reference and telemetry keys, and every 1:1 link.

### 2.4 Org assumptions written into the schema

- Alto: `OrgSetting.orgName` default "Alto HR" and `info@altohr.com`; role comments about "the Alto vans"; "agents Alto already runs".
- Florida and Eastern time: `Location.timezone` defaults to `America/New_York`; `PayrollConfig` comment "the org is Florida-only"; `ReliabilityWeek` is Saturday-to-Friday Florida-local; Destin named three times.
- Saturday workweek in comments on FieldglassTimesheet, TimesheetFiling and ReliabilityWeek, while `Client.weekStartsOn` defaults to Sunday and the overtime comment says Monday-to-Sunday. The workweek must become a tenant setting (Brief 2-2 makes it a rule).
- Money: `$5` fare and `$1` no-show defaults, `0.67` mileage rate, `fieldglassBillRate` "for this SOW". No `$15`/`$18` in the schema (those live in code, §7).
- Walmart: `ComplianceTag.WALMART_CADE`, Walmart positions and SOP temperature limits seeded by migrations, "Walmart MTSA", "Walmart vendor portal".
- Fieldglass, QuickBooks: per-client fields and connections; these stay per client.
- Synchros: not in the schema (only `lib/bulkPiiExport.ts`).
- Role and RelayDesk enums encode Alto's org chart; Brief 2-3 makes roles tenant-defined.

### 2.5 Migrations

250 folders named `YYYYMMDDHHMMSS_name` (the newest prefixes are ordering keys, not dates). Thirty contain data writes that assume one employer, and the ones a tenant migration must respect:

- `20261001090000_alto_pay_schedule` rewrites every active PayrollSchedule to Alto's biweekly Saturday rule and inserts the company-wide schedule.
- `20261005090000_walmart_temperature_limits` and `20260616000000_add_shift_positions` seed Walmart-specific SOP limits and positions into every Client.
- `20261106090000_workers` picks "the first org-wide admin" as the default worker owner; `20261030090000_driver_client_access` grants every driver every client; `20261103090000_program_lifecycle` dedupes sponsors by global name.
- `20260502030000_org_settings` creates the singleton CHECK; `20261107090000_agent_registry` creates the append-only trigger on AuditLog.

No RLS policies, no `current_setting`, and no sequences other than the pay-check autoincrement exist today.

### 2.6 The Prisma client today

`apps/api/src/db.ts` keeps one client across reloads, logs warnings and errors, and wraps it in one `$extends` with two parts: the `shift` writes that fill `workerId` from the assignee (Brief 1D-1), and a top-level `$allOperations` retry on connection errors. The result is cast back to `PrismaClient`. The worker lookup inside the extension uses the **unextended** base client. A tenant-injecting extension belongs in this same call, and three things bypass it today: `prisma/seed.ts`, about twenty scripts under `apps/api/scripts/`, and `apps/api/test/db.ts`, which creates its own `PrismaClient` for fixtures and truncation (90 tables listed, `payroll_config` preserved, an isolation test that walks the foreign-key graph).

## 3. What resolves the tenant today: nothing

- The JWT carries `{ sub, role, ver, amr }` and no tenant. `attachUser` (`middleware/auth.ts:115-260`) loads client, location, region and associate ids and caches the user by `sub` for 30 seconds.
- `lib/scope.ts` has 20 helpers (`scopeShifts`, `scopeTimeEntries`, `effectiveClientIdFilter`, …). **Every one of them returns `{}` for an org-wide role.** Under tenancy that empty filter is the cross-tenant hole; it is exactly what the extension in §9.3 closes, so the helpers do not need to change.
- API keys (`middleware/apiKeyAuth.ts`): `altop_` bearer, looked up by `last4` across every key, then a hash check; `clientId` null means a global key that lists every client (`integrationsV1.ts:92-110`).
- Agent credentials (`middleware/agentAuth.ts`): lookup by token hash; `routes/agentApi.ts:97-152` takes `clientId` from the query string with no scope check (fine today, a hole tomorrow).
- Kiosk: the device token resolves a device; the four-digit PIN is matched by **one global HMAC** (`routes/kiosk99.ts:1909, 2090, 2310`), which also means only 10,000 PINs exist across all tenants.
- Login finds the user by email alone (`routes/auth.ts:375`) and reads the MFA rule from the singleton (`:490`).
- Five singleton settings rows are read in 12 files: `orgSetting` (branding, MFA rule, payout policy), `submitterProfile` (EIN and filing identity on every 941/W-2 path in `payrollTax91.ts` and `payroll.ts`), `agentControl`, `programAlertSetting`, `transportSettings`.
- Public and anonymous entry points and where their tenant will come from:

| Route | Tenant from |
|---|---|
| `/auth/login`, forgot-password | host name, or platform-unique email (§9.4) |
| invite, reset, email-change, offer-letter, WebAuthn login | the token or credential row's user |
| `/auth/oidc/callback` | one identity provider from env today; per tenant in Brief 2-3 |
| `/integrations/v1`, `/agent/v1` | the key or credential row |
| `/scim/v2` | one `SCIM_TOKEN` today; must become a per-tenant token (Brief 2-3) |
| `/calendar/v1/:associateId/:token` | the associate |
| `/communications/unsubscribe/:token` | the token encodes only an email, then looks the user up by email: ambiguous once emails repeat across tenants |
| `/careers*` | host name or slug |
| `/anonymous-reports` | host for filing; tracking code for lookup |
| `/branch/webhook`, `/resend/webhook`, `/whatsapp/webhook` | the referenced payroll item, notification or phone consent |
| `/quickbooks/connect/callback` | signed state → client |
| `GET /admin/org/settings/logo` | host, or a tenant in the URL |

## 4. Raw SQL (bypasses any Prisma extension)

Fourteen sites. The ones that read or write tenant data unscoped: `routes/analytics.ts:193, 207` (hours and shift counts per week, optional client only), `routes/complianceScorecard.ts:1596` (org-wide hours), `routes/scheduling.ts:869` (labor cost join, inlines the default pay rates), `lib/kioskMaintenance.ts:91` (UPDATE TimeEntry by ids from an unscoped query), `lib/reliability.ts:238` (kiosk punches per day), `lib/workers.ts:85, 89` (UPDATE Shift and Worker from all rows). Advisory locks with global names: `lib/opsSops.ts:301` (`alto.ops_sop_seed`, seeds templates when the global count is zero), `lib/scheduleDigest.ts:198`. Per-user and per-associate locks are safe. The RLS wall in §9.5 covers all of these; the four UPDATE/aggregate sites also get the tenant added explicitly.

## 5. Background jobs: 46 timed jobs, none tenant-scoped

All are started from `apps/api/src/index.ts:84-158`; each `start*Cron` has a timer guard and an interval env gate. Every one queries the whole database: invite reminders, onboarding purge, stale nudge, due invites, recruiting cleanup, dormancy sweep, ops digest and SOP sweep, portal digest, service report mail, portal engagement digest, portal coverage alert, attestation reminder (fans out through `notifyAllAdmins`), expiration digest, compliance snapshot (whose `null` scope means "whole org"), kiosk maintenance, document maintenance, report schedules, uploads backup (tars the whole upload root), shift reminders (overtime alert uses the env default bill rate), schedule digest, ready-to-work nudge, executive digest and alerts, relay escalation, shift autofill, no-show risk, auto clock-out, week-ahead, offer letters, usage and vitals flushers (keyed by day/route, no tenant), reliability digest (`ReliabilityWeek` keyed by week only), program digest, the worker and agent sweeps, agent drift, webhook delivery, idempotency cleanup, notification retention, van-trail retention, plus the branding preload. Two timers live outside index.ts: the user-cache prune (`middleware/auth.ts:102`) and the live-events ping.

Calendar logic baked in: executive and reliability digests send Saturdays after a set hour in Eastern time; program and portal-engagement digests send Mondays; every digest dedupes by `startOfWeekUTC(now)`, which is Saturday 00:00 Eastern. These become tenant settings (workweek start, time zone, digest hours) read inside the per-tenant loop.

## 6. In-memory state keyed without a tenant

| Where | State | Key today |
|---|---|---|
| `lib/branding.ts:42-44` | one branding snapshot per process, refreshed every 5 min; read synchronously in email layout, notifications, paystubs, TOTP issuer, season-plan PDF | none |
| `middleware/auth.ts:74` | user cache, 30 s | `userId` |
| `middleware/rateLimit.ts` | 20 limiters | `ip:`, `email:`, `user:`, `apiKey:` prefixes, no tenant |
| `lib/kioskRateLimit.ts:65-90` | punch throttle, PIN back-off | `deviceId` |
| `lib/agents.ts:234, 486` | built-in agent ids; agent rate windows | `builtInKey` (globally unique today); `workerId` |
| `lib/usageTracker.ts:96, 98`, `lib/webVitals.ts:136` | usage and vitals buffers | day/method/route, no tenant |
| `lib/liveEvents.ts:25` | live-event streams | `userId` |
| `routes/complianceScorecard.ts:122` | active-associates cache | `clientId ?? '*'`; **`'*'` would mix tenants** |
| `routes/kiosk99.ts:1680` | `legacyDevicesExist` | global flag |
| `lib/oidc.ts`, `lib/sentryApi.ts`, `lib/notifications.ts` (Resend throttle), `lib/disbursement.ts`, `lib/whatsapp.ts`, `lib/webPush.ts`, `lib/blobStore.ts:291` | one provider account each, from env | per process |
| `lib/geocode.ts`, `lib/payrollTax.ts`, formatter caches | address cache, IRS config, timezone formatters | safe to share |

## 7. Branding, identity and constants in code

- **Branding** is `lib/branding.ts` over the `OrgSetting` singleton (`orgName` default "Alto HR"); the web reads it through `/admin/org/settings`, and the logo endpoint is public.
- **Email**: `lib/emailLayout.ts:82-89` hard-codes the legal name "Alto Etho LLC d/b/a Alto HR", address, phone and support address; the "Sent by Alto HR" footer in three languages; `publicBaseUrl()` falls back to `people.altohr.com`; `lib/emailTemplates.ts` carries `hr@altohr.com`, `altohr.com` and six literal "Alto HR" subjects; `lib/notify.ts` defaults subjects to "Notification from Alto HR"; one `RESEND_FROM` and reply-to.
- **Documents**: `lib/altoHrContent.ts` is the employment agreement, policies and handbook with about 138 Alto and Walmart references; PDF and XLSX authors and footers in 14 files name Alto; `paystubData.ts:186` falls back to "Alto Etho LLC"; the employer name on 941s and W-2s falls back to "Alto HR" in `payroll.ts` and `payrollTax91.ts`.
- **Time zone**: `lib/timezone.ts:18` `DEFAULT_TIMEZONE = America/New_York` imported by 32 files; `ORG_TZ` constants in 10 files; 20 more literals in ops, payroll, relay and finance code; the web has `OPS_TZ`.
- **Workweek**: `orgDateKey` (27 files) and `startOfWeekUTC`/`endOfWeekUTC` (31 files) in `lib/timeAnomalies.ts` hard-code Saturday in Eastern time; `lib/timesheetWeek.ts:83` `saturdayWeek`. A per-client `weekStartsOn` exists in contracts and is ignored by these helpers.
- **Rates**: `config/env.ts:273-292` `DEFAULT_ASSOCIATE_PAY_RATE` 15, `DEFAULT_LEAD_PAY_RATE` 18, bill rates 21.21 and 24.24, burden 12%, cost per separation 400; used in 11 files including raw SQL in `routes/scheduling.ts`; `lib/financeCockpit.ts:27` has its own `PAYROLL_DEFAULT_RATE = 15`; `routes/complianceScorecard.ts:66-106` has `WALMART_BILL_RATES`.
- **Careers**: `/careers` lists every open posting; the slug is globally unique; the feed uses the branding name and `APP_BASE_URL`.
- **Sentry**: `lib/sentry.ts` sets only DSN, environment and sample rate. No tag or user context anywhere, API or web.
- **Integrations and secrets that are one-per-install**: QuickBooks app credentials (connection is per client), Fieldglass constants, ASN Nexus key, Branch and Wise accounts, WhatsApp phone number, VAPID keys, `KIOSK_PIN_SECRET`, `SCIM_TOKEN`, `CALENDAR_FEED_SECRET`, `PULSE_HASH_SECRET`, OIDC provider. Thirty-odd env vars describe this org rather than the platform (`APP_BASE_URL`, `RESEND_*`, `DEFAULT_*_RATE`, digest hours, dormancy days, `STORAGE_S3_PREFIX`, …).
- **Seeds and scripts**: `prisma/seed.ts` looks users up by email, creates `admin@altohr.com` and the Alto policies; `scripts/` holds about twenty one-off tools on a raw client.

## 8. Storage and browser state

- **Blob keys carry no tenant segment.** Patterns: `${id}-${sha}${ext}` at the bucket root (documents, external payments), `i9/${associateId}/…`, `esign/${agreementId}/…`, `messages/…`, `ops-photos/…`, `profile-photos/${associateId}-…`, `relay-work/${id}/…`, `offers/…`, `letters/…`. One bucket and one `STORAGE_S3_PREFIX`; local driver under one `UPLOAD_ROOT`; the backup job tars it all into one bucket. The org logo lives as bytes on the settings row; kiosk selfies on database rows.
- **Web query persistence** (`lib/queryPersist.ts`): IndexedDB record `client:${userId}`, 24 h, `APP_CACHE_VERSION = 'v4'`, sensitive keys excluded, cleared on sign-out. Query keys are ad-hoc arrays in about 235 files with no central factory and no tenant segment; safe only because the client is cleared on sign-out.
- **Service worker** (`public/sw.js`): `alto-shell-v18-<build>` and `alto-shared-intake` cache names; `/api/*` never cached; push fallback title "Alto People". Shared across tenants on one origin.
- **localStorage**: the sign-out purge removes every `alto*` key except device-scoped prefixes. Risks on a shared device: `alto.ops.client` holds a client id with no user key; `alto.nav.*` and `alto.whatsnew.seen.v2` survive sign-out, the latter with no user key; kiosk device token and offline punch queue survive by design (the device belongs to one tenant).
- **Cross-tenant test sizing**: 113 route files, about 1,260 handlers, 129 mounts in `app.ts` (50 routers mounted at `/` that gate per route), 240 API test files of which about 20 already test cross-client cases. Fixtures: `createUser`, `createClient` (with a default Location), `createAssociate`, `createGlobalPolicy` write without any tenant; `loginAs` posts email and password. E2E has two personas and a 560-line seed keyed by email.

## 9. Isolation strategy

### 9.1 Principle

Two independent walls. The application wall injects the tenant into every query so ordinary code cannot forget it. The database wall refuses any row from another tenant even when application code is wrong, bypassed (raw SQL, scripts, a future bug) or compromised. The brief asks for both; the second is what makes the first auditable.

### 9.2 Data model

- `Tenant { id, slug @unique, name, plan, status, createdAt }`. `OrgSetting` gains `tenantId @unique` and the branding, settings and feature flags the brief lists (`features Json`, logo, colors, name), replacing the singleton. The other four singletons gain `tenantId @unique` the same way.
- `tenantId UUID NOT NULL` on every table except the platform-telemetry group in §2.2, where it is nullable. Foreign key to `Tenant` with `ON DELETE RESTRICT`. An index on `(tenantId)` on every table; composite indexes that drive hot queries get `tenantId` as the leading column where the planner needs it.
- Every unique constraint in §2.3 becomes `@@unique([tenantId, …])`. `PayCheck.checkNumber` becomes a per-tenant counter kept on `Tenant` (or a `TenantSequence` row) assigned in the pay-run transaction.
- The eleven denormalized `clientId` columns keep working; `tenantId` is the column RLS reads, so no joins are needed in policies.

### 9.3 The application wall: request context plus a Prisma extension

- A `tenantContext` built on `AsyncLocalStorage` holds `{ tenantId, source }` for the life of a request, a job iteration or a script run. Nothing in it is readable by other requests.
- The `$extends` in `db.ts` gains a `$allModels.$allOperations` hook that, for every model with a `tenantId` column: adds `tenantId` to `where` on reads, updates and deletes (`AND`-ed, never replaced), sets `tenantId` on `create`, `createMany` and `upsert`, and **throws** when no tenant is in context (the "fail closed" rule from `lib/scope.ts` applied platform-wide). A small allow-list (`Tenant`, the telemetry group, `PayrollConfig`) is exempt. Nested writes get the same treatment through the `data` tree.
- A `withTenant(tenantId, fn)` helper for jobs, sweeps and scripts, and a `withPlatformScope(fn)` escape hatch that is itself audited (an `audit` row with action `platform.scope_opened`) so that every cross-tenant read by the platform operator is on the record.
- The model allow-list and the per-model column presence are generated from the Prisma DMMF at startup and checked by a test, so adding a model without `tenantId` fails CI rather than slipping through.

### 9.4 Resolving the tenant

| Caller | Rule |
|---|---|
| Browser session | `User.tenantId`, loaded by `attachUser` with the user. Email stays globally unique in 2-1 so sign-in needs no host resolution; Brief 2-3 (SSO) can relax it per identity provider. |
| Client portal account | the same; the account is created inside its tenant |
| API key (`/integrations/v1`) | `ApiKey.tenantId`, set from the creator |
| Agent credential (`/agent/v1`) | `AgentCredential → AgentProfile → Worker.tenantId` |
| Kiosk device | `KioskDevice.tenantId` via its client |
| Webhook receivers (Resend, Branch, WhatsApp) | the row they reference (`notificationId`, `payrollItemId`, phone → consent) resolves the tenant; a payload that resolves to nothing is logged and dropped |
| Invite, password reset, offer-accept, anonymous-report links | the token row carries the tenant |
| Public pages (careers, apply) | the host name (`careers.<tenant-slug>.…` or a `tenant` query key) maps to `Tenant.slug`; Alto HR is the default host for one release so nothing public breaks on day one |
| Background jobs | iterate `Tenant` rows and run each tenant inside `withTenant`; a job that needs a cross-tenant view (reliability, usage) runs inside `withPlatformScope` |

### 9.5 The database wall: row-level security

- `ALTER TABLE … ENABLE ROW LEVEL SECURITY; FORCE ROW LEVEL SECURITY` on every tenant-scoped table, with one policy `USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)` and the same `WITH CHECK`. A second policy `USING (current_setting('app.platform_scope', true) = 'on')` allows the audited platform scope.
- The application connects as a role that is **not** the table owner (owners bypass RLS), created by the migration: `alto_app` with `SELECT/INSERT/UPDATE/DELETE` on the schema. Migrations keep running as the owner.
- The tenant reaches the connection per transaction: the extension runs `SELECT set_config('app.tenant_id', $1, true)` and the query inside one `$transaction([...])` batch (the Prisma-documented RLS pattern). With a transaction-mode pooler in production this is exactly what works, since `SET LOCAL` lives and dies with the transaction. Interactive transactions (104 call sites) get the `set_config` once at their start through the same hook, detected by the transaction id on the client, so the extension never opens a nested transaction.
- Raw SQL (§7) runs inside the same hook and therefore inside the same setting; a raw statement issued outside a tenant context fails at the database, which is the point.
- `TRUNCATE` in the test harness runs as the owner and is unaffected.

### 9.6 Storage, caches, queues and telemetry

- Blob keys gain a `tenants/<tenantId>/` prefix; existing objects are re-keyed by a one-off script with a redirect map kept for 30 days.
- Every in-memory map in §7 keys on `tenantId:` first; the rate-limit key generators join the tenant id; the branding cache becomes a per-tenant map.
- Browser persistence (`queryPersist`, localStorage keys, the service-worker cache name) is namespaced by tenant slug and `APP_CACHE_VERSION` is bumped so a shared device never shows another tenant's cached page after a sign-out.
- Sentry gets a `tenant` tag set from the context in the request and job wrappers; log lines carry it through the request logger.
- Email: sender name and reply-to come from the tenant's `OrgSetting`; the sending domain stays shared in 2-1.

### 9.7 Alto HR becomes tenant 1, with zero downtime

1. **Migration A (additive, no lock risk):** create `Tenant`, insert the Alto HR row with a fixed id, add `tenantId` **nullable** to every table with a default of that id, backfill in batches of 10,000 rows per table, add the indexes `CONCURRENTLY`. The app keeps running; every new row gets the default.
2. **Deploy B:** the request context and the extension go live in *observe* mode: a query with no tenant in context logs a warning with the call site instead of throwing. The cross-tenant test suite runs against the API with a second tenant seeded.
3. **Migration C:** `tenantId` becomes `NOT NULL`, the default is dropped, the unique constraints are rewritten, the singleton CHECK and the five singleton ids are converted.
4. **Deploy D:** the extension throws on a missing context; RLS is enabled with the `alto_app` role; the app connects as that role.
5. **Deploy E:** blob re-keying, cache namespacing, Sentry tags, per-tenant jobs.
6. **Deploy F:** the tenant admin (invite users, set roles, upload branding), the test tenant seeded with the full associate journey.

Each step is reversible by redeploying the previous one; migrations A and C are additive and leave the old columns in place.

### 9.8 Proving it

- **Cross-tenant suite:** a generated test that logs in as a tenant-2 admin, a tenant-2 portal account, a tenant-2 API key, a tenant-2 agent and a tenant-2 kiosk device, then calls **every mounted route** with tenant-1 ids taken from the seed (one id per entity type) and asserts 403 or 404 and no row change. Routes are enumerated from the Express router at test time so a new route cannot be missed. The same suite runs every background job with tenant 2 present and asserts tenant 1's rows were untouched and tenant 1 got no notification.
- **Policy test:** a raw connection as `alto_app` with no setting returns zero rows from every tenant-scoped table; with tenant 2 set, returns none of tenant 1's rows.
- **Reconciliation:** Brief 1A-1's report is the acceptance line for "Alto HR is unchanged after migration". It does not exist yet; §10 lists it as the first dependency.

## 10. Decisions needed before coding

1. **Email uniqueness.** Recommendation: keep `User.email` unique across the platform in 2-1 (one person, one account, one tenant), so sign-in, password reset and the unsubscribe link keep working without host resolution. Revisit in Brief 2-3 if a customer needs the same address in two tenants.
2. **Host names.** Recommendation: `people.altohr.com` stays the Alto HR tenant and the default; each new tenant gets `<slug>.altohr.com` (or a custom domain later). Only public pages (careers, logo, apply, anonymous reports) need the host; signed-in traffic resolves from the session.
3. **Employer facts on `Client`** (`legalName`, `ein`, `sutaRateOverride`, `weekStartsOn`). Recommendation: move the employer identity to the tenant's `SubmitterProfile` and keep `weekStartsOn` per client as a scheduling preference; Brief 2-2 turns the workweek into a rule.
4. **Reference data**: `PayrollConfig`, `LocalTaxRule`, `WcClassCode`. Recommendation: `PayrollConfig` and `LocalTaxRule` stay global; `WcClassCode` becomes per tenant because the rate per $100 is the employer's.
5. **Email suppression list**: global (one sending domain) or per tenant. Recommendation: global while the domain is shared.
6. **Employee numbers**: the four-digit kiosk PIN space becomes per tenant (10,000 per tenant, matched under the device's tenant). The kiosk-pin index drift (§2.3) must be checked in production first.
7. **Telemetry**: `RouteUsageDaily`, `WebVitalDaily`, `ReliabilityWeek` stay platform-wide with a nullable tenant column, so the reliability dashboard still reads one number for the platform. A per-tenant view is a later addition.
8. **The Alto-specific content**: the employment agreement, policies, handbook (`lib/altoHrContent.ts`), Walmart SOP templates and positions, Walmart bill rates. Recommendation: they become the Alto HR tenant's rows (policies and templates already have tables) rather than code, seeded once into tenant 1; the test tenant gets neutral equivalents.
9. **Reconciliation**: the acceptance line "Alto HR's reconciliation report is unchanged after migration" needs Brief 1A-1 to exist. Recommendation: build 1A-1 before migration C in §9.7, since that is the step that rewrites constraints.
10. **The Synchros columns** for 1A-1 are still outstanding.

## 11. Scope and sizing

The build splits into six shippable steps (§9.7). Rough weight, in order: the tenant model and migration A (schema, 268 models, generated from the DMMF) is the largest single change; the extension and request context are small but touch every entry point; the per-tenant loop in 46 jobs is mechanical; the unique-constraint rewrite is careful work on 36 constraints; RLS and the `alto_app` role are a migration plus the connection string; storage and cache namespacing are a script and a version bump; the tenant admin is a page and three routes. The cross-tenant suite is generated from the router, so it grows with the codebase rather than being hand-written.

None of it starts until the decisions in §10 are made.
