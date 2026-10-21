# Docs audit A–D (access-cleanup-1a4, ach-own-account, agent-families, agent-product-billing, asn-integration, control-room, design-system)

Audited against the working tree on 2026-10-21 (uncommitted batch included). Read-only; no tests run.

---

## docs/access-cleanup-1a4.md — Brief 1A-4 Users & access cleanup

**Verdict: 12 of 12 repo-side deliverables built; the two production acceptance steps (run the scripts against prod, reconnect Intuit) cannot be checked from the repository.**

Not fully built:
- **Acceptance report with production numbers / QuickBooks reconnect in prod** — status: UNTESTED (out of repo) — evidence: `apps/api/scripts/access-report.ts`, `apps/api/scripts/audit-encryption-key.ts` exist; the doc itself says the runs need production — what's left: owner runs the two `railway run` commands and the Intuit reconnect.

Built:
- `GET /admin/users/access-report[?format=csv]` — `apps/api/src/routes/users.ts:727` (gated `view:hr-admin`), CSV via `accessReportCsv`
- Report rows, counts (total, byStatus, byRole, activeAssociates via activeDefinition, flagged, byFlag) and all 7 flags — `apps/api/src/lib/accessCleanup.ts:46-118`, duplicate-person gmail normalisation `:116`, activity-day fallback `:147`
- `User.lastSeenAt` stamped at login (`apps/api/src/lib/loginSecurity.ts:58`) and on activity (`apps/api/src/lib/usageTracker.ts:179`)
- `POST /admin/users/deactivate` (own account / LIVE_ASN / already-deactivated → `skipped`, sessions ended via tokenVersion, `admin.user_deactivated` with ip+ua) — `accessCleanup.ts:286-335`
- `POST /admin/users/:id/reactivate` (ACTIVE or INVITED, `daysLeft` audited) — `accessCleanup.ts:337-368`, `users.ts:760`
- `startAccessPurgeCron` every 6h, soft delete + `admin.user_deleted_after_grace` — `accessCleanup.ts:369-406`, started in `apps/api/src/index.ts:262`
- `POST /clients/:id/portal-users` needs `locationId` unless `wholeClient: true` — `apps/api/src/routes/clients.ts:1338-1366`
- Region scope needs `approvedByUserId` holding manage:org, `regionApprovedById/At`, `portal.region_scope_approved`, `selfApproved` — `accessCleanup.ts:415`, `apps/api/src/routes/region.ts:267-293`, `users.ts:248,324`
- QuickBooks `needsReconnect` + 409 `quickbooks_reconnect_required` + reconnect UI — `apps/api/src/routes/quickbooks.ts:57`, `apps/api/src/lib/quickbooks.ts:19`, `apps/web/src/pages/clients/QuickbooksSection.tsx`
- Access report section of the Users page + Download CSV + deactivate dialog — `apps/web/src/pages/admin/AccessReport.tsx`, `UsersAdmin.tsx:917`
- Scripts `access-report.ts --csv`, `audit-encryption-key.ts` — `apps/api/scripts/`
- Tests — `apps/api/src/__tests__/routes/accessCleanup.test.ts` (4 cases: flags, deactivate/reactivate/sweep, store-level invite, region approver)

---

## docs/ach-own-account.md — Own-account ACH

**Verdict: 11 of 12 deliverables built; 1 partial (mark-uploaded does not accrue tax deposits, liabilities or garnishment remittances).**

Not fully built:
- **Mark uploaded "accrues the tax deposit, the tax liabilities and the garnishment remittances"** — status: PARTIAL — evidence: `apps/api/src/lib/banking/directDeposit.ts:303-350` (`markFileUploaded`) flips items to DISBURSED, emails paystubs, settles the run to DISBURSED — but never calls `accrueDepositsForRun`, `postLiabilitiesForRun`, `accrueRemittancesForRun` or `booksAfterPayrollRun`. The disburse route only runs those when `allSucceeded` (`apps/api/src/routes/payroll.ts:2322-2338`), which is false in OWN_ACCOUNT mode because the paychecks are still PENDING at that moment. Result: an own-account run that settles via Mark uploaded has no tax-deposit obligation, no liability posting and no garnishment remittance rows. `ownAccountAch.test.ts` has no assertion on accruals — what's left: call the three accrual functions (and the books posting) from `markFileUploaded` for each run in `runsSettled`, plus a test.

Built:
- `settlement` / `fileFormat` columns + migration `20270124100000_own_account_ach` — `apps/api/prisma/schema.prisma:13830-13832`
- `ownAccount()`, `OFFSET` entry kind, balanced-file gap — `apps/api/src/lib/banking/ach.ts:61,82,87`
- PENDING-until-uploaded in `AchRailAdapter.finalize()`, `markFileUploaded()`, same-day only with a partner in `creditEffectiveDate()`, sweep settles only SUBMITTED own-account files — `directDeposit.ts:143,217,303,603`
- Funding routes answer `own_account` / nothing to pull — `apps/api/src/lib/banking/funding.ts:130,317,342`
- `POST /payroll-banking/files/:id/uploaded`, `uploadable`, profile fields — `apps/api/src/routes/banking.ts:150,232-233,451`
- Guided close carries `bankFile` — `apps/api/src/routes/payroll.ts:2458-2607`; `BankFileStep` in `apps/web/src/pages/payroll/PayrollClosePage.tsx:363`
- Go-live line "Company account at the bank" / "Offset account" — `apps/api/src/lib/payrollGoLive.ts:171-173`
- Web: SetupTab (settlement, file format, Same day hidden without partner `:132`), FilesTab Mark uploaded `:125-141`, AccountsTab "Draw payroll on this account" `:134`, PayrollBankingPage banner + Funding tab copy `:173-201`
- Tests — `apps/api/src/__tests__/routes/ownAccountAch.test.ts` (balanced, unbalanced + go-live, never settles unmarked / sweep; `sameDay: false` asserted at `:128`)

---

## docs/agent-families-investigation.md — Workforce + Compliance families, Hugo

**Verdict: step 0 and steps 1–6 built (8 catalog capabilities, gates, proposals, per-tenant switch/built-ins, fixture runner, Hugo intents + app panel, MCP preview); 1 acceptance item unverifiable; 1 open question still open.**

Not fully built:
- **Acceptance "both agents live in Alto HR for a week with scorecards"** — status: UNTESTED (operational) — evidence: scorecard code and tests exist (`agentFamiliesStep0.test.ts:143`, `workforceForecastAndHugo.test.ts:132`, `credentialCoverage.test.ts:91`); a week of production numbers is not in the repo — what's left: owner observes a week.
- **Owner question "`open:hr-case` vs lending `manage:onboarding`"** — status: built as proposed (`open:hr-case` in `packages/shared/src/contracts.ts:8812`); the doc records no owner answer — what's left: owner confirms.

Built (step 0):
- `AgentCapability`, `AgentProposal` (+`AgentProposalStatus`), `AgentTenantControl`, `SHIFT_ASSIGN`/`CASE_OPEN` enum values, builtInKey partial unique indexes, tenant backfill — `apps/api/prisma/schema.prisma:12229-12237,12439-12520,12677`; migration `apps/api/prisma/migrations/20261123090000_agent_capabilities/migration.sql:13-80` (named 20261123, not the doc's 20261121)
- Catalog `AGENT_CAPABILITIES` + `capabilitiesFor(modules)` with fixtures — `packages/shared/src/agentCapabilities.ts:259-375` (8 doc capabilities + a later `payroll.prep`)
- Scopes `view:org`, `manage:scheduling`, `manage:compliance`, `open:hr-case`; `AGENT_EXECUTABLE_ACTIONS` — `packages/shared/src/contracts.ts:8797-8862`
- Routes: `/agents/:id/capabilities[/:key/suspend|resume|scorecard]`, `/agents/proposals`, `/agents/control`, `/agents/suspend-all|resume-all`, `/agents/platform/*` (operatorOnly), `POST /agent/v1/proposals` — `apps/api/src/routes/agents.ts:196-303,638-665`, `apps/api/src/routes/agentApi.ts:202`
- Tenant + platform switch read on every agent call — `apps/api/src/lib/agents.ts:389-390,763`
- Per-tenant built-ins at boot — `apps/api/src/index.ts:220` (`runForEachTenant` → `ensureBuiltInAgents`); family agents `workforce-agent`, `compliance-agent` — `lib/agents.ts:197,214`
- Desk-side approval items — `apps/api/src/lib/roleDecisions.ts:668` (`pendingDeskApprovals`), `proposalDecisions.test.ts`
- Tests 1–7 of §8.5 — `apps/api/src/__tests__/routes/agents.test.ts:429-516`, `apps/api/src/__tests__/tenancy/agentFamiliesStep0.test.ts` (tenant switch, per-tenant registry, built-ins, capability scorecard/switch, fixture runner, modules → capabilities, hotel words), cross-tenant fixture `crossTenant.test.ts:83`

Built (steps 1–6):
- `shift.fill` — `apps/api/src/lib/workforceAgent.ts` (`runShiftFill` :409, bench by site via `benchFor` in `shiftAutofill.ts:63`, cron `startShiftAutofillCron` calls it); tests `tenancy/workforceShiftFill.test.ts` (7)
- `attendance.confirm` — `apps/api/src/lib/attendanceConfirm.ts:331`, `AttendanceConfirmation` model, `/hugo/confirm`; tests `workforceAttendanceConfirm.test.ts` (9)
- `schedule.repair` — `apps/api/src/lib/scheduleRepair.ts`; hooks: time-off `routes/timeOff.ts:569,699`, separation `separationComplete.ts:67`, deactivation `deactivation.ts:121`, emergency `emergency.ts:525`; tests `workforceScheduleRepair.test.ts` (10)
- `coverage.forecast` + relay baton — `apps/api/src/lib/coverageForecast.ts:174`, `relayBoard.ts:2`; tests `workforceForecastAndHugo.test.ts`
- Hugo: `HUGO_INTENTS`, `intentsFor`, `detectHugoIntent` — `apps/api/src/lib/hugo.ts:85-229`; WhatsApp uses it `whatsappAssistant.ts:3`; routes `apps/api/src/routes/hugo.ts:258-335`; app panel `apps/web/src/pages/admin/HugoPanel.tsx`, `HugoSeat.tsx`; forbidden-word hotel case `workforceForecastAndHugo.test.ts:214`
- `document.chase` (30/14/3 ladder `complianceAgent.ts:152`, waivers `:92`), `i9.section2` worklist — `apps/api/src/lib/complianceAgent.ts`, cron `index.ts:176`; tests `tenancy/complianceAgent.test.ts` (12)
- `incident.loop` (3/7/14 days, 300A line, CASE_OPEN) — `apps/api/src/lib/incidentLoop.ts`; tests `tenancy/incidentLoop.test.ts` (6)
- `coverage.credentials` weekly — `apps/api/src/lib/credentialCoverage.ts:124`; tests `tenancy/credentialCoverage.test.ts` (5)
- MCP catalog from `capabilitiesFor` — `apps/api/src/lib/mcpCatalog.ts:65`, `routes/mcp.ts`; `agentFamiliesAcceptance.test.ts`
- Agents page: Capabilities & gates tab, per-capability scorecard, "This organization" switch + "Platform switch" — `apps/web/src/pages/admin/AgentRecordPage.tsx:42,182`, `AgentGovernance.tsx:304,391`

---

## docs/agent-product-billing-investigation.md — Brief 2-6 registry as a product + billing

**Verdict: 5 of 6 steps built; 3 partials (Tenant billing fields + billing contact/payment method on the page; decision notices are recorded, not sent; prices/Stripe account are owner inputs still pending).**

Not fully built:
- **Tenant `billingName`, `billingEmail`, `stripeCustomerId` (risk table: "go on Tenant now")** — status: MISSING — evidence: no match in `apps/api/prisma/schema.prisma` or `apps/api/src`; the Stripe customer is re-found each time by metadata search (`apps/api/src/lib/billing.ts:199-203`) — what's left: three nullable columns + migration, or accept the metadata search as the design.
- **Billing page shows "the billing contact and the payment method from Stripe"** — status: PARTIAL — evidence: `apps/web/src/pages/admin/BillingHome.tsx` shows plan, running counts, invoices with hosted links; no contact or payment-method section (no match for `contact`/`paymentMethod`) — what's left: read the Stripe customer's email/default payment method and render it.
- **Notices "reuse the communications rails (email layout, EN/ES/TR) with a versioned notice text per profile"; NYC notice text; Colorado point-of-interaction notice and adverse-outcome explanation** — status: PARTIAL — evidence: `apps/api/src/lib/decisionRecord.ts:225-243` only stamps `noticeGivenAt`/`explanationSentAt`/… when a person posts `POST /agents/decisions/:did/events` (`routes/agents.ts:626`); no notice template, no send, `noticeTextVersion` hard-coded to 1; `decisionRecord.test.ts` covers the hold and append-only, not a sent notice — what's left: the notice texts (EN/ES/TR), a send path through the comms rails, and the version stamp from the profile.
- **Prices per plan and the Stripe account (owner decisions 3 and 4)** — status: UNTESTED (owner input) — evidence: `billing.test.ts:84` "waits for prices, then for Stripe"; `PlanPrice` model exists, invoice holds with `holdReason` until prices and a key exist — what's left: owner enters prices and the test-mode key.
- **Acceptance "a Stripe test invoice whose quantities equal the counts"** — status: UNTESTED against live Stripe — evidence: `billing.test.ts:84,129` mock the Stripe calls — what's left: one real test-mode run.

Built:
- Registry isolation (`listAgents` tenant-filtered `apps/api/src/lib/agents.ts:477-480`), cross-tenant agent fixture (`crossTenant.test.ts:83`), Custom picker (`apps/web/src/pages/admin/AgentCatalogPicker.tsx:33`), `tenancy/registryIsolation.test.ts` (3)
- `AgentGatePolicy` + `gateFor` resolver with unlowerable floor, `/agents/gates[/preview|/:gid/end]`, Gates panel — `schema.prisma:13219`, `apps/api/src/lib/agentGates.ts:43-74`, `routes/agents.ts:316-360`, `apps/web/src/pages/admin/AgentGatesPanel.tsx`; `tenancy/agentGates.test.ts` (4)
- `AgentDecisionProfile`, `AgentBiasAudit`, append-only `AutomatedDecisionRecord` (trigger in `migrations/20261201110000_automated_decision_record/migration.sql:101-141`), `compliance_hold` (`lib/agentCapabilities.ts:324`, `decisionRecord.ts:106-109`), record tab + CSV (`routes/agents.ts:583-591`, `apps/web/src/components/agents/AgentDecisionRecordTab.tsx`); `tenancy/decisionRecord.test.ts` (4), `agentDisclosure.test.ts` (5)
- Active rule for AGENT/ROBOT in the one place — `apps/api/src/lib/activeDefinition.ts:279-300`
- `UsageSnapshot`, `UsageRecord`, `PlanPrice`, `BillingInvoice` — `schema.prisma:13337-13405`; daily `runUsageSnapshots` via `startBillingCron` — `lib/billing.ts:56,247`, `index.ts:204`
- Stripe adapter counts+prices only, test-mode gate, webhook signature-checked and mounted before `express.json` — `lib/billing.ts`, `routes/billing.ts`, `app.ts:430` (before `:438`); `tenancy/billing.test.ts` (6)
- Billing nav off `billRates`: `requiresAny: ['manage:org','process:payroll']` — `apps/web/src/lib/modules.ts:1963-1971`
- Support requests → platform inbox (bell via `notifyUser`), `/support/*` — `apps/api/src/routes/support.ts`, `apps/web/src/pages/support/SupportPage.tsx`, HelpSheet link `:121`; `STATUS_PAGE_URL` public config shown on sign-in (`SsoDiscovery.tsx:47`); platform release notes `tenantId NULL` + `platform: true` — `routes/releaseNotes.ts:27-48`; `tenancy/customerSuccess.test.ts` (3)
- Acceptance test — `tenancy/agentProductAcceptance.test.ts:37`

---

## docs/asn-integration.md — ASN read-only integration API

**Verdict: 8 of 9 documented behaviours built; the endpoints themselves are UNTESTED (only the OpenAPI shape test exists); one doc/code mismatch on the audit label; one undocumented module gate.**

Not fully built:
- **Endpoint behaviour tests (`/me`, `/stores`, schedule, roster, clocked-in, kpis; 404 on foreign store; 403 on `/stores` with a store key; 401 collapse; 429)** — status: UNTESTED — evidence: `apps/api/src/__tests__/routes/integrationsOpenapi.test.ts` only checks the spec is served, matches the router's paths and has operationIds; no test file hits `/integrations/v1/stores…` with an `altop_` key (grep: no match in `__tests__`) — what's left: a route test with a global and a store-scoped key.
- **Audit log shows "api-key: <name>"** — status: PARTIAL — evidence: `apps/api/src/middleware/auditFloor.ts:80` records `metadata.apiKeyId` only; no "api-key:" label anywhere — what's left: either the doc changes or the audit metadata gains the key name.
- **Mount is gated on the `payrollSync` module** — status: built but undocumented — evidence: `apps/api/src/app.ts:467` `requireModule('payrollSync')`; a tenant with that module off gets no ASN API — what's left: say so in the doc or lift the gate.

Built:
- Router + capabilities per endpoint, 500 cap, `days` 1–30, store-scope 404, `/stores` 403 for store keys — `apps/api/src/routes/integrationsV1.ts:56-375`
- `altop_` bearer, 401 collapse, revoked/expired, 403 `forbidden` — `apps/api/src/middleware/apiKeyAuth.ts:24-151`
- 60 req/min/key, draft-7 headers, `rate_limited` — `apps/api/src/middleware/rateLimit.ts:312-327`
- Key admin (create once-shown, last4, revoke) — `apps/api/src/routes/apiKeysWebhooks93.ts:62-121`, `apps/web/src/pages/integrations/IntegrationsHome.tsx:134-277`
- OpenAPI document — `apps/api/src/lib/integrationsOpenapi.ts`
- CORS via `CORS_ORIGIN` — `app.ts:414`

---

## docs/control-room-investigation.md — Brief 3-3 Control room + hybrid planner

**Verdict: 10 of 10 deliverables built; acceptance tests present as listed; 4 open owner questions remain open (not deliverables).**

Not fully built:
- (none) — the four "Open questions" (crew-lead roles, offline-robot page, PDF mix columns, per-robot cost) are explicitly deferred in the doc. PDF still lacks mix columns: `apps/api/src/lib/seasonPlanPdf.ts` has no `robotsNeeded`/`backupCrew` (grep: CSV only in `seasonPlanner.ts:633`).

Built:
- Seam `lib/tasks/robotAvailability.ts` used by the engine — `apps/api/src/lib/tasks/engine.ts:11`
- Span of control (`spanOfControl`, `robotsOnShiftAt`, `crewLeadsOnFloor`, `spanOfControlAt`) — `apps/api/src/lib/tasks/spanOfControl.ts:16-62`; `warnings[]` on `startRobotShift` (`lib/robots.ts:336-363`) and `POST /tasks`, `/tasks/:id/auto` (`routes/tasks.ts:107,143`)
- `GET /control-room`, `/control-room/sites`, `view:time-live`, behind `scheduling` module — `apps/api/src/routes/controlRoom.ts:22-36`, `app.ts:617`, `lib/controlRoom.ts`
- Page `/control-room` in Operations door, 15s poll, Emergency stop/Resume, Suspend all agents, Hand to a person — `apps/web/src/pages/controlRoom/ControlRoomPage.tsx:31,69,119,354,423`, `apps/web/src/lib/modules.ts`
- Planner: `SeasonPlanSite.taskDemand`, `WorkTaskPolicy.robotUtilizationPct/backupCrewRatioPct/maxRobotsPerCrewLead` — `schema.prisma:12034,14223-14226`; `proposeMix` — `lib/tasks/mix.ts:44`; totals + 7 CSV columns — `lib/seasonPlanner.ts:380,633`; `TaskDemandEditor.tsx`, mix columns + "At peak" line — `SeasonPlannerHome.tsx:645-705`
- Tests — `routes/controlRoom.test.ts` (3), `routes/hybridPlanner.test.ts` (within 10%), `lib/hybridMix.test.ts` (4), web `ControlRoomPage.test.tsx` (3)

---

## docs/design-system.md — Design system standard

**Verdict: 14 of 15 standard pieces built; the page sweep is by design incremental (baseline-tracked debt remains); design walk is manual.**

Not fully built:
- **Rules "rounded-xl and larger are not used", "no raw shadow-*", "no window.confirm", "no toLocaleDateString", no `text-white`** — status: PARTIAL (sweep debt, tracked) — evidence: page files still using them: `rounded-xl|2xl|3xl` 17, raw `shadow-(sm|md|lg|xl|2xl)` 5, inline hex 8, `text-white` 243 of 480, `toLocaleDateString` 3, `window.confirm` 2 (grep over `apps/web/src/pages`); `design-baseline.json` only stops rises — what's left: the sweep the doc describes ("when a screen is touched").
- **Design walk "runs on every design brief"** — status: PARTIAL — evidence: `.github/workflows/design-walk.yml:8-9` is `workflow_dispatch` only (manual), covers desktop/phone, dark/light, EN/ES/TR (`apps/web/e2e/design-walk.spec.ts:41,138-140`) — what's left: nothing if "run by hand per brief" is the intent; otherwise a trigger.

Built:
- Job-named tokens in `apps/web/src/index.css` (26 hits), exposed in `apps/web/tailwind.config.js:43-93` (surface/ink/accent/positive/caution/2xs…)
- `tokenContrast.test.ts` both themes — `apps/web/src/__tests__/a11y/tokenContrast.test.ts:55-65`; axe tests in the same dir
- Five templates with `data-template` — `apps/web/src/components/templates/*` (Home 12 pages incl. all nine listed homes, List 169, Record 12, Desk 6, Settings via `SettingsArea.tsx` shell)
- `useGreeting` — `apps/web/src/lib/greeting.ts:30`; `settingsRail.ts`; `AgentGlyph` — `components/agents/AgentGlyph.tsx:85`
- Nav coverage test — `apps/web/src/__tests__/lib/navCoverage.test.ts`
- Design lint + baseline + CI gate — `apps/web/scripts/design-lint.mjs`, `design-baseline.json`, `package.json` `lint:design`, `.github/workflows/ci.yml:57`
- Size budget — `apps/web/size-budget.json`
- `/design-system` page — `apps/web/src/App.tsx:588` (`pages/platform/DesignSystemPage.tsx`)
