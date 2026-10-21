# Docs audit F–P: forecasting, identity/RBAC/audit, integrations, labor rules, multi-tenancy, product taxonomy, public API

Audited against the working tree on 2026-10-21 (uncommitted batch included). All paths are under `/Users/aetheris/Alto People/Alto-People-/`. Read-only; nothing was run.

Status legend: MISSING = nothing found; PARTIAL = some of the deliverable exists; STUB = code exists but is not wired to anything; UI-ONLY = page without server rule; UNTESTED = built but the doc's named test/proof is absent.

---

## docs/forecasting-investigation.md (Brief 3-4)

**Verdict: 11 of 11 deliverables built; 0 partial.** The doc is a "what was built" record and every line checks out.

Not fully built: none.

Built:
- `ForecastRun`/`ForecastSiteWeek`/`ForecastSignal`/`ForecastAccuracy` models — `apps/api/prisma/schema.prisma:13657-13721`; migration `apps/api/prisma/migrations/20261206100000_forecasting`
- Routes `/forecast/sites`, `/sites/:locationId`, `POST /runs`, `PUT /signals`, `DELETE /signals/:id`, `POST /plan`; `view:org` read, `manage:org` write — `apps/api/src/routes/forecast.ts:23-94`; mounted behind `requireModule('scheduling')` at `apps/api/src/app.ts:615`
- Monthly cron per tenant, checked every 6 h, scores accuracy before computing — `apps/api/src/lib/forecast/cron.ts:14`, `apps/api/src/lib/forecast/run.ts:215-222` (`scoreForecastAccuracy` then `computeForecastRun`); armed at `apps/api/src/index.ts:194`
- Planner handoff (hours ÷ 7 ÷ shiftHours, day/evening/overnight split, horizon note) — `apps/api/src/lib/forecast/run.ts:343-388`
- Web `/forecast` page with tiles, chart, Now line, Details table, 15 % badge, signals and plan dialogs — `apps/web/src/pages/forecast/ForecastHome.tsx:210,220,304,347,437`; nav entry "Demand forecast" in the workforce-management group — `apps/web/src/lib/modules.ts:1335-1343`; planner "Start from the forecast" — `apps/web/src/pages/planner/SeasonPlannerHome.tsx:133`
- Synthetic acceptance test (>200 site-weeks, summer and all-year MAPE < 15, positive last-year weight, band ≥ ±15 %) — `apps/api/src/__tests__/lib/forecastModel.test.ts:110-126`; route test `apps/api/src/__tests__/routes/forecast.test.ts`; web test `apps/web/src/__tests__/pages/ForecastHome.test.tsx`
- Script `apps/api/scripts/forecast-backtest.ts`; shared contracts `packages/shared/src/forecast.ts` (exported from index)

---

## docs/identity-rbac-audit-investigation.md (Brief 2-3)

**Verdict: 24 of 28 deliverables built; 3 partial, 1 untested.** All five rollout steps landed; the gaps are inside the proofs the doc named, not the features.

Not fully built:
- **§7 "20 scripted actions" acceptance test** — status: PARTIAL — evidence: `apps/api/src/__tests__/tenancy/auditAcceptance.test.ts:44-99` covers actions 1, 2, 4, 5–6, 8, 9, 10, 13, 18, 20 plus the UPDATE/DELETE/TRUNCATE refusals and a forged-edit detection (`:112-119`) — what's left: actions 3 (OIDC sign-in), 7 (invite), 11 (pay rate change), 12 (payout method revealed), 14 (W-4), 15 (shift create/delete), 16 (time entry approved), 17 (payroll run created and finalized), 19 (agent gated call) are not in the scripted test. Half the script.
- **RBAC equivalence proof: the router walk** — status: UNTESTED — evidence: `apps/api/src/__tests__/lib/rbacEquivalence.test.ts:42-62` iterates every archetype × every capability against `can()` and both middlewares, but there is no `listRoutes()` walk calling every gated route as each built-in role (grep for `listRoutes` in that file: no match) — what's left: the "before and after the switch, identical status classes" route walk named in §4.3.
- **Hash-chain nightly verifier job** — status: PARTIAL — evidence: `apps/api/src/lib/auditChain.ts:44,91` (`verifyAuditChain`, `runAuditChainChecks`) exist; `auditChainCheck` rows are written only from the manual route `apps/api/src/routes/audit.ts:221` and the chain is read inside the evidence sweep (`apps/api/src/lib/evidence.ts:179`, cron at `index.ts:191`) — what's left: no dedicated nightly chain check that writes an `AuditChainCheck` row and alerts on a break; it is folded into the evidence sweep as a pass/fail line.
- **Env IdP retired after migration to a connection row** — status: PARTIAL (by design drift) — evidence: `apps/api/src/lib/identity.ts:51` `ensureEnvIdentity` creates the row at runtime; `apps/api/src/routes/oidcAuth.ts:270,322,405` still fall back to env; `apps/api/src/config/env.ts:542` still parses `OIDC_ISSUER_URL`; no `identity.v2` flag found — what's left: the env path is kept as a fallback rather than retired; no per-tenant feature flag. Functionally fine, doc-divergent.
- **Okta/Entra end-to-end with a real dev org (step 5 acceptance)** — status: UNTESTED — evidence: CI twins exist (`apps/api/src/__tests__/routes/samlAuth.test.ts`, `identityPerTenant.test.ts`, `scim.test.ts`), no evidence of a real-org run — what's left: owner-dependent; cannot be verified from the tree.

Built:
- Step 1 audit floor middleware, awaited, `http.<method>`/`http.export` — `apps/api/src/middleware/auditFloor.ts:59-106`, mounted `apps/api/src/app.ts:451`; tests `__tests__/tenancy/auditFloor.test.ts`
- Tenant filter on audit viewer and CSV, streamed uncapped export — `apps/api/src/routes/audit.ts:39,102,156`
- Trigger covers `tenantId`; BEFORE TRUNCATE guard keyed on `alto.allow_audit_truncate='test'` — `apps/api/prisma/migrations/20261122093000_audit_floor/migration.sql:28,40-42`
- Step 2 `IdentityConnection`, `TenantDomain`, `UserIdentity`, `ScimToken` — `schema.prisma:13019,13052,13179,13200`; migration `20261201090000_identity_per_tenant`
- DNS TXT verification — `apps/api/src/lib/identity.ts:2,147-153`; discovery by email domain and slug — `:100,115`; `/login/:slug` — `apps/web/src/App.tsx:786`; `SsoDiscovery.tsx`
- Subject binding, subject change refused — `apps/api/src/lib/identity.ts:176-191`
- SCIM resolves tenant from token; `/Groups` + `ScimGroup`/`ScimGroupRoleMap` — `apps/api/src/routes/scim.ts:118-142,972`; `schema.prisma:13480,13493`; `lib/scimGroups.ts`
- Step 3 `TenantRole` with archetype ceiling, system rows, `can()` resolver, `requireCapability` on `can` — `apps/api/src/lib/tenantRoles.ts:46-69,130-145`; `apps/api/src/middleware/auth.ts:505,531`; matrix page `apps/web/src/pages/admin/RolesMatrix.tsx`; `permission.changed` with before/after — `tenantRoles.ts:138`
- API refuses module-hidden roles — `assertRoleOffered` used at `apps/api/src/routes/users.ts:412-414`, `accessGrants.ts:9`
- Step 4 before/after with masking as a Prisma extension — `apps/api/src/lib/auditDiff.ts:15-78`, wired `apps/api/src/db.ts:4,167`; tests `auditDiff.test.ts`, `auditDepth.test.ts`
- Hash chain trigger under per-tenant advisory lock — `migrations/20261202100000_audit_chain/migration.sql:17,42-51`
- Retention 7-year floor, raise only, archive to encrypted object store — `schema.prisma:12851` (`Tenant.auditRetentionYears`), `lib/auditChain.ts:27,131-146`, archive run in `lib/evidence.ts:192-198`
- SIEM HTTPS sink with signed deliveries and cron — `lib/auditSink.ts:30-126`; `index.ts:208`; route `routes/audit.ts:235`; `AuditSink`/`AuditSinkDelivery` models
- Step 5 SAML on `@node-saml/node-saml` 5.1, SP metadata, InResponseTo always unless IdP-initiated allowed, DB replay cache, clock skew — `apps/api/src/lib/saml.ts:1,36-79`; `routes/samlAuth.ts:70`; `apps/api/package.json:35`
- SSO required for staff with break-glass — `lib/identity.ts:215-217`, `lib/breakGlass.ts:26-32`, `TenantSecurityPolicy.breakGlassEnabled` (`schema.prisma:13083`)

---

## docs/integrations-investigation.md (Brief 3-5)

**Verdict: 14 of 14 deliverables built; 0 partial.** Live vendor paths wait on credentials by design.

Not fully built: none.

Built:
- Adapter interface with seven capabilities, `AdapterContext`, `SyncOutcome`, redaction — `apps/api/src/lib/integrations/adapter.ts`; domain loader `domain.ts`
- Models + migration — `schema.prisma:14018,14048,14072`; `migrations/20261207100000_integrations`; `sandbox @default(true)` (`:14026`)
- Runner `runSync`, `runScheduledSyncs`, `syncForEvent` with 60 s debounce, `installEventSync` on `onWebhookEvent` — `lib/integrations/sync.ts:58,189,243-272`; `lib/webhookDispatch.ts:78`; five-minute per-tenant sweep `apps/api/src/index.ts:251-254`
- Registry — `lib/integrations/registry.ts`; vendors `vendors/{fieldglass,adp,workday,ukg,beeline}.ts`; ADP reconciliation to the cent — `vendors/adp.ts:27-30`
- Routes `/integration-connections` (vendors, list, create, read, patch, delete, test, sync, runs, run errors) gated `view:`/`manage:integrations`, every change audited — `apps/api/src/routes/integrationConnections.ts:39-212`; mounted `app.ts:486`
- Credentials in `FIELD_COLUMNS` keyring — `apps/api/src/lib/keyring.ts:38`
- Web Connections section, connect drawer with mapping editor, connection page with per-record error drawer — `apps/web/src/pages/integrations/connections/{ConnectionsSection,ConnectDrawer,ConnectionPage}.tsx`; `IntegrationsHome.tsx:80-84`
- Shared vendors/capabilities/mapping/zod (PURE-wrapped) — `packages/shared/src/integrations.ts:104-121`
- Tests: catalog, sandbox default, cross-tenant invisibility, each vendor's sandbox proof, clock and events, redaction — `apps/api/src/__tests__/routes/integrationConnections.test.ts:61-290`

---

## docs/labor-rules-investigation.md (Brief 2-2)

**Verdict: 17 of 22 deliverables built; 3 partial, 1 stub, 1 doc-divergent.** Engine, packs, storage, shadow, sign-off switch and overrides are real; the "one engine for every caller" decision and the scheduling warn/block are not.

Not fully built:
- **Decision 2 / step 4: every §2.2 caller computes through the engine (sheet, statements, estimators)** — status: PARTIAL — evidence: only `apps/api/src/lib/payrollAggregator.ts:18` (via `laborRules/live`), `lib/predictabilityPay.ts:4-6`, `lib/timeCorrections.ts` and `lib/laborRules/overrides.ts` import the engine; `payrollSheet.ts`, `clientStatement.ts`, `associateEarnings.ts`, `financeCockpit.ts`, `executiveSummary.ts`, `shiftReminder.ts`, `transport.ts`, `timeAnomalies.ts`, `routes/executive.ts`, `routes/scheduling.ts` each have 0 references to `laborRules` — what's left: the ten other copies of "40 h, 1.5×" still compute on their own; the sheet-vs-pay daily-OT disagreement (§1.2) is unresolved for the sheet; estimators can disagree with the check.
- **Step 5: `evaluateSchedule` wired into scheduling (warn/block at shift creation, minors block)** — status: STUB — evidence: `apps/api/src/lib/laborRules/evaluate.ts:353` defines it and `__tests__/laborRules/engine.test.ts:239-276` unit-tests it; no caller outside the lib (grep `evaluateSchedule` in `apps/api/src` excluding tests and `evaluate.ts`: no match; `routes/scheduling.ts` has 0 `laborRules` references) — what's left: call it from the shift create/update/publish paths with the per-tenant severity defaults (decision 7).
- **Decision 1: jurisdiction from the work site everywhere** — status: PARTIAL — evidence: `lib/laborRules/live.ts:122,335` keys live pay on `site.state`; `lib/timeAnomalies.ts:558,638` and `routes/time.ts` still read `associate.state` — what's left: anomalies (and `timeOffAccrual`, `externalPayrollSheet`) still follow the home state.
- **Golden fixtures for the ride guard and a re-aggregate of a past run** — status: PARTIAL — evidence: `__tests__/laborRules/golden/florida-biweekly.json` holds 11 items (alabama-44, breaks-docked, central-friday-night, client-premium, default-rate, only-approved-in-period, ot-42-split-shift, overnight-friday, rate-change-mid-period, salaried, straight-40) — what's left: no ride-min-wage-guard fixture, no past-run re-aggregate fixture (the DB twin `goldenDb.test.ts` covers a run but not the guard).
- **Shipped packs in `packages/shared/src/laborPacks/` with zod in `packages/shared`** — status: doc-divergent (built elsewhere) — evidence: packs live in `apps/api/src/lib/laborRules/packs.ts:48-251` and zod in `apps/api/src/lib/laborRules/params.ts`; `packages/shared/src/laborPacks/` does not exist and `RuleParamsSchema` is not in shared — what's left: nothing functional; the location differs from the plan.

Built:
- Step 0 golden capture and test — `__tests__/laborRules/golden.test.ts:28-53`, `goldenDb.test.ts`, `apps/api/scripts/labor-golden.ts`
- Step 1 engine core: families (overtime, meal, rest, restBetweenShifts, minors, predictive, minimumWage, custom), resolution with "protective wins", outcomes with reason lines — `lib/laborRules/{params,resolve,evaluate,packs}.ts`; FEDERAL/FL/AL + CA/NYC/Chicago packs with citations, DRAFT by default — `packs.ts:48-137,142-223`; tests `engine.test.ts:74-376`
- Step 2 `LaborRuleSet` with partial unique indexes, duplicate-refused test, seeding — `schema.prisma:12936`; migrations `20261130090000_labor_rule_sets`, `20261130110000_labor_packs_ca_ny_il`; `__tests__/laborRules/ruleStore.test.ts:47`; Rules page per site with citation — `apps/web/src/pages/payroll/LaborRulesPage.tsx:104`; routes `apps/api/src/routes/laborRules.ts:58-124`
- Step 3 shadow beside every finalized run, cron, shadow tab, dry-run script — `lib/laborRules/shadow.ts:81-163`; `index.ts:199`; `LaborRulesPage.tsx:148,200`; `apps/api/scripts/labor-dry-run.ts`; `__tests__/laborRules/shadow.test.ts`
- Step 4 per-jurisdiction/site LIVE switch with counsel sign-off, change report, approval request — `LaborRuleActivation` (`schema.prisma:14492-14512`); `lib/laborRules/live.ts:113-122`; routes `laborRules.ts:246-289`; DRAFT never payable (`engine.test.ts:128`)
- Step 5 penalties as paystub lines when LIVE (meal, rest, rest-between) — `live.ts:153-188`, `payrollAggregator.ts:930`; minors by `Associate.dob` age band — `engine.test.ts:138,253-264`; CA fixed-week acceptance — `engine.test.ts:293-319`; NYC/Chicago — `:325-359`
- Step 6 override editor, union custom params, cross-tenant test, audit on every change — `apps/web/src/pages/payroll/LaborOverridesSection.tsx`; `routes/laborRules.ts:172-193`; `__tests__/laborRules/overrides.test.ts:41-100` (incl. "a rule changed for one tenant leaves another's unchanged")

---

## docs/multi-tenancy-investigation.md (Brief 2-1)

**Verdict: 11 of 23 deliverables built; 5 partial, 7 missing.** Steps A and B (plus the enforce switch) shipped; Migration C, the RLS wall (D), and most of E and F are not in the tree.

Not fully built:
- **Migration C: `tenantId NOT NULL`, default dropped** — status: MISSING — evidence: `schema.prisma` has 481 `tenantId String?` and 0 required `tenantId` columns; `migrations/20261222100200_tenant_id_step_one/migration.sql` explicitly moves new tables back to nullable-with-default — what's left: the whole constraint rewrite.
- **Migration C: unique constraints per tenant (36 listed)** — status: MISSING — evidence: `User.email @unique` (`schema.prisma:424`, by decision 1), `Associate.email @unique` (`:2099`), `PayCheck.checkNumber` global SERIAL (`:4360-4366`), kiosk PIN "global pinHmac collision" (`routes/kiosk99.ts:711`) — what's left: Associate/Candidate email, pay-check counter, kiosk PIN space, sponsor/skill/asset/decision keys, filed-941 partial index, etc.
- **Migration C: singleton conversion** — status: PARTIAL — evidence: `OrgSetting` has `tenantId @unique` but keeps `id 'singleton'` and the comment "Alto HR's row keeps id 'singleton'" (`schema.prisma:10204,10229`); `SubmitterProfile` still `@default("singleton")` (`:7423`) — what's left: drop the CHECK and fixed ids for the five singletons.
- **Deploy D: row-level security + `alto_app` role** — status: MISSING — evidence: no migration contains `ROW LEVEL SECURITY`, `set_config('app.tenant_id'`, or `alto_app` (grep over `apps/api/prisma` and `apps/api/src`: no match) — what's left: the entire database wall, the non-owner role, the per-transaction `set_config`, and §9.8's policy test.
- **Deploy E: blob keys under `tenants/<tenantId>/` + re-keying script** — status: MISSING — evidence: `apps/api/src/lib/blobStore.ts` has no `tenant` reference — what's left: all of it.
- **Deploy E: rate-limit keys joined with the tenant** — status: MISSING — evidence: `middleware/rateLimit.ts:71-94` key generators use `mfa:`, `email:`, `ip`; the only tenant mention is a comment at `:309` — what's left: tenant segment in the key generators.
- **Deploy E: Sentry `tenant` tag and request-log tenant** — status: MISSING — evidence: no `setTag` with tenant anywhere in `apps/api/src` — what's left: tag from the request/job context.
- **Deploy E: browser persistence namespaced by tenant, SW cache name, `APP_CACHE_VERSION` bump** — status: MISSING — evidence: `apps/web/src/lib/queryPersist.ts:53` still `'v4'`, record key `client:${userId}`, no tenant; `apps/web/public/sw.js:26` `alto-shell-v18-<build>` — what's left: tenant slug in the persist key, cache name and localStorage keys.
- **Deploy E: every one of the 46 jobs inside `withTenant`** — status: PARTIAL — evidence: 59 of 61 `start*Cron/Sweep` entry points in `index.ts` go through `tenantJob`/`runForEachTenant`; `lib/billing.ts` (`startBillingCron`) and `middleware/idempotency.ts` (`startIdempotencyCleanupCron`) do not — what's left: those two (idempotency cleanup is arguably platform telemetry).
- **Deploy F: test tenant seeded with the full associate journey** — status: PARTIAL — evidence: `prisma/seed.ts` and `scripts/seed-demo.ts` create no second `Tenant` (seed.ts:320 is a second *client*); `__tests__/tenancy/crossTenant.test.ts:158` creates `tenant-two` at test time; `hotelJourney.test.ts` is a direct employer in the Alto tenant — what's left: a seeded second tenant with the journey.
- **Deploy F: tenant admin (invite users, set roles, upload branding)** — status: PARTIAL — evidence: `routes/tenancy.ts:40-51` + `apps/web/src/pages/admin/TenantProfileHome.tsx` manage modules/profile; invites, roles and branding stay on the existing Users and Branding pages — what's left: nothing functional, but no tenant-creation/onboarding flow for a *new* tenant was found.
- **§9.4 webhook receivers resolve the tenant from the referenced row; unresolvable payload logged and dropped** — status: PARTIAL/UNVERIFIED — evidence: `routes/branchWebhook.ts`, `routes/resendWebhook.ts`, `routes/whatsapp.ts` contain no `tenant`, `withTenant` or `withPlatformScope` reference — what's left: confirm how these run under `TENANCY_MODE=enforce` and add the resolve-or-drop rule.

Built:
- `Tenant` model and migration A — `schema.prisma:12837`; `migrations/20261110090000_tenant_column`; Alto id constant `lib/tenant.ts`
- Deploy B tenant guard with `TENANCY_MODE` (default now `enforce`), observations route, audited `withPlatformScope` — `lib/tenantGuard.ts` (DMMF-driven at `:40`), `config/env.ts:491`, `routes/tenancy.ts:18-33`; tests `__tests__/lib/tenantGuard.test.ts`
- DMMF "every model has tenantId except reference data" test — `__tests__/lib/tenant.test.ts:27-50`
- Cross-tenant suite enumerated from the router with a shrinking baseline — `__tests__/tenancy/crossTenant.test.ts` + `crossTenant.baseline.json`; site-scope twin `siteScope.test.ts`
- Tenant resolution for sessions, API keys, agent credentials, kiosk devices — `middleware/apiKeyAuth.ts:118` (`runWithTenant`), agent/kiosk per the shipped step-two note
- Per-tenant branding cache — `lib/branding.ts:9-69`
- Per-tenant job wrapper — `lib/tenantJobs.ts:49-72`
- `WcClassCode.tenantId` (decision 4) — `schema.prisma:7035`; `ExecTarget` per tenant — `migrations/20261228100000_exec_target_per_tenant`
- Careers filtered by tenant — `routes/career126.ts:29,85` (by context, not by host; host→slug mapping for public pages not found)
- `TenantSecurityPolicy` (beyond the doc) — `schema.prisma:13069`

---

## docs/product-taxonomy.md

**Verdict: 9 of 9 rules built; 0 partial.** Two cosmetic notes only.

Not fully built: none. Notes:
- Nav group labels are sentence case ("Workforce management", "Payroll and finance", "Client services") rather than the doc's Title Case — `apps/web/src/lib/modules.ts:176-181`; and `client-services` relabels to "Communications and Insights" when the tenant has no clients (`:642`). Cosmetic.
- `Compass` appears as a lucide icon import on `apps/web/src/pages/NotFound.tsx:2,10`, not as a product name. Within the rule.

Built:
- `PRODUCT_NAME`, `ASSISTANT_PLATFORM_NAME`, `ASSISTANT_NAME_PROMPT` — `packages/shared/src/contracts.ts:7141-7143`
- `OrgSetting.assistantName @default("Hugo")` per tenant — `schema.prisma:10207`; prompt on the Branding page — `apps/web/src/pages/admin/BrandingHome.tsx:338`; test `__tests__/pages/admin/BrandingHome.test.tsx`, `__tests__/tenancy/assistantName.test.ts`
- First message / "who are you" names the product and says AI — `apps/api/src/lib/whatsappContent.ts:242,252,336`; model system prompt `lib/assistantModel.ts:86`
- No hard-coded "Hugo" in a message string (only the default in `lib/branding.ts:43` and a design-system note) — grep over api/web string literals
- Agent record carries `family` and `capability`; Agents page groups by family — `schema.prisma:12267-12271`; `AGENT_FAMILIES` `packages/shared/src/contracts.ts:8824`; `apps/web/src/pages/admin/AgentRegistryAdmin.tsx:144-182` (`groupAgentsByFamily`)
- Six product groups as module groups — `apps/web/src/lib/modules.ts:165-181`
- Brief 2-7 MCP server — `apps/api/src/app.ts:471`, `packages/mcp-stdio`
- First families Workforce and Compliance — `__tests__/tenancy/workforce*.test.ts`, `complianceAgent.test.ts`

---

## docs/public-api-investigation.md (Briefs 2-4 and 2-7)

**Verdict: 27 of 32 deliverables built; 4 partial, 1 missing.** Steps 0–7 all landed; the gaps are the replica-safe limiter, the public developer page, the spec example check, the per-webhook success rate and the MCP read tools.

Not fully built:
- **Per-client/per-tenant limiter on a Postgres store when `MULTI_REPLICA=1`** — status: MISSING — evidence: `apps/api/src/lib/v1/define.ts:37-49` sets 600/min per client and 3,000/min per tenant on the in-process express-rate-limit store; no `store` option there or in `middleware/rateLimit.ts` (grep `store|Store`: no match in define.ts); `index.ts:302-330` refuses to boot under `MULTI_REPLICA=1` without a shared backend — what's left: the shared store the doc named (the boot guard makes it safe, not built).
- **`/developers` page is public** — status: PARTIAL — evidence: `apps/web/src/App.tsx:619` wraps it in `RequireCapability cap="view:integrations"` — what's left: the doc says public; it is admin-only. Content (quick start, Node signature snippet, event list, reference from the generated spec) is there (`pages/integrations/DevelopersPage.tsx:11-125`); a Python snippet was not found.
- **Spec test (c): every operation's example validated against its response schema** — status: UNTESTED — evidence: `__tests__/routes/publicApiV1.test.ts:114-134` validates with swagger-parser and matches `listRoutes()` both ways; no example-vs-schema assertion (grep `example`: only email fixtures) — what's left: part (c).
- **Per-webhook "last 7 days success rate" on the Integrations page** — status: MISSING — evidence: grep `success rate|successRate|last 7` in `pages/integrations/*.tsx` and `routes/apiKeysWebhooks93.ts`: no match.
- **MCP tools `read_schedule`, `my_scorecard`, `my_requests`, `request_approval`, `open_case` by name** — status: PARTIAL — evidence: `lib/mcpServer.ts:20-25,71-81` exposes one tool per offered capability (`shift_fill`, `attendance_confirm`, `schedule_repair`, `coverage_forecast`, `document_chase`, …, generated by `lib/mcpCatalog.ts:42-65`) plus `whoami` and `approval_status` — what's left: the read-only tools the doc named (`read_schedule`, `my_scorecard`, `my_requests`) have no equivalent; `open_case`/`propose_shift_fill` exist under capability keys. Acceptance "reads a week" is therefore not literally met; proposal + approval id + 401 after revocation are (`__tests__/routes/mcp.test.ts:52,120-153`).

Built:
- Step 0 tenant-filtered fan-out and admin lists — `lib/webhookDispatch.ts:95-102`; `routes/apiKeysWebhooks93.ts:16,21`
- Step 1 `ApiClient`, `POST /v1/oauth/token`, `requireApiToken`, scopes, rotation 5-min overlap, revoke stops issued tokens, `AuditLog.apiClientId` — `schema.prisma:12651,5179`; `routes/v1.ts:77`; `lib/apiClients.ts`; tests `publicApiV1.test.ts:71-112`; admin UI `pages/integrations/ApiClientsTab.tsx`
- Step 2 `defineRoute` + `@asteasolutions/zod-to-openapi` registry, `/v1/openapi.json`, validator + route-match test — `lib/v1/define.ts`; `routes/v1.ts:101`; `apps/api/package.json:29,64`; idempotency re-keyed on principal — `middleware/idempotency.ts:60`; Idempotency-Key required on POST — test `:176`
- Step 3 reads: workers, sites, shifts, time-entries, documents, programs, agents with public schemas and exclusion tests — `routes/v1.ts:142-619`; `lib/v1/{schemas,mappers}.ts`; tests `:135-166`; cross-tenant token test `:225`
- Step 4 writes: workers create/patch, shifts create/patch/assign/cancel, audited under client + owner — `routes/v1.ts:181-424`; test `:192-223`
- Step 5 five events (`shift.created/changed`, `time_entry.approved`, `worker.status_changed`, `program.alert`, `agent.approval_requested/decided`) from one shared list — `lib/webhookEvents.ts:12-85`; `lib/agents.ts:858,924`; `routes/scheduling.ts:3041,3342` (10 `emitShiftEvent` call sites); `packages/shared/src/publicApi.ts:80`
- Signature v2 with timestamp, legacy header for 90 days, secrets sealed with `WEBHOOK_SECRET_KEY` + backfill, redeliver, `/v1/webhooks` — `lib/webhookDispatch.ts:219-223,347`; `lib/webhookSecrets.ts`; `migrations/20261129100000_webhook_secret_sealed`; `routes/v1.ts:662-759`; tests `:243-310`
- Step 6 sample script + CI twin — `apps/api/scripts/sample-integration.ts`; `__tests__/routes/publicApiSample.test.ts`
- Step 7 MCP over Streamable HTTP + stdio forwarder, agent credentials only, every call on the trail as `mcp.<method>`, gated tool returns a pending approval — `routes/mcp.ts`, `lib/mcpServer.ts`, `packages/mcp-stdio/{bin,forwarder}.mjs`; tests `mcp.test.ts:52-153`
