# Web code audit — half-finished work (apps/web, working tree as of 2026-10-21)

Method: grep sweeps for markers; skip/todo sweep over src/__tests__ and e2e; orphan-file and
uncalled-export scripts (importers counted excluding __tests__); every `apiFetch`/`fetch('/api…')`
path literal in apps/web/src cross-checked against the routers app.ts mounts (2,032 web calls vs
1,986 server paths after resolving `${B}` prefixes and trailing query interpolations);
`node scripts/i18n-check.mjs` re-run with a per-file listing; `node scripts/design-lint.mjs`
per-file breakdown from design-baseline.json (totals equal the baseline, so it is current).

Counts: markers 7 · tests 6 skipped (+11 env-gated e2e) · dead/orphan 3 files + 66 uncalled
exports (15 more test-only) + 0 placeholder routes · i18n 109 literals in 15 files, design-lint
143/33/19/4 · flags 2 build-time, 2 server-"configured" features · missing endpoints 0 (two
client functions target routes that don't exist, but nothing calls them).

## 1. Markers (TODO/FIXME/soon/stub/no-op/alert/console.log)

No TODO, FIXME, XXX, HACK or WIP comments exist anywhere in apps/web/src; no `console.log`,
no `throw new Error('not implemented')`, no `href="#"`, no `onClick={() => {}}` on a real button.
What remains are "coming soon" surfaces:

- **Compliance scorecard "Coming soon" badges** — apps/web/src/pages/compliance/ComplianceScorecard.tsx:1058 (and the comment at :245) — the Shifts and Billing tiles render a `Coming soon` badge for every signal the server marks `unsupported`; apps/api/src/routes/complianceScorecard.ts:1049-1053 hard-codes five such signals (No-show rate, Shift Lead present, Temperature logs with photos, MOD sign-off captured, Fieldglass timesheet by Mon 2pm) with reason "Connect ASN Nexus … to enable" — a client-facing contract scorecard that permanently shows five placeholders. Left: compute the five signals from shifts/attestations/Fieldglass data already in the schema, or drop the rows.
- **WhatsApp card says "coming soon" when the server isn't configured** — apps/web/src/components/WhatsAppCard.tsx:53 (`settings.whatsapp.comingSoon`) — on the associate Settings page the card shows "WhatsApp updates are coming soon." whenever `/whatsapp/me` returns `configured: false`; the associate can't tell it's an ops gap. Left: either hide the card when unconfigured or word it as "not turned on for your company".
- **StubTask "Coming in a future phase"** — apps/web/src/pages/onboarding/tasks/StubTask.tsx:32 (route `onboarding/me/:applicationId/tasks/:taskKind`, App.tsx:500) — the fallback onboarding task page with the `ob.stub.*` copy about "S3 file storage, signature pad UX, or third-party APIs scheduled for a later phase". Every one of the 11 `TaskKind` values in packages/shared/src/contracts.ts:50 now has a real route (App.tsx:462-498), so this is unreachable except by typing a bogus kind. Left: delete StubTask + the 8 `ob.stub.*` keys in i18n.tsx/tr.ts, or turn the route into a 404.
- **AssociateChecklist "Coming soon" pill** — apps/web/src/pages/onboarding/AssociateChecklist.tsx:609 (`ob.check.comingSoon`) and the `REAL_KINDS` set at :163-179 — the non-linkable branch only fires for a task kind outside REAL_KINDS, and REAL_KINDS now equals the whole enum. Left: remove the branch and the gate (and the "falls through to the StubTask" comment at :162).
- **ModulePlaceholder "Phase 1 placeholder / Module not yet implemented"** — apps/web/src/pages/ModulePlaceholder.tsx:27-30, registered at App.tsx:976 — `PLACEHOLDER_MODULES` (App.tsx:779) is computed as modules whose path has no explicit route; all 145 distinct module paths in lib/modules.ts now have one, so the array is empty and the component never mounts. The comment at App.tsx:39 ("used by ~50 placeholder routes") is stale. Left: delete the file, the import, the `PLACEHOLDER_MODULES` block and the comment.
- **Photo storage banner tells operators uploads are on temp disk** — apps/web/src/components/PhotoStorageBanner.tsx:60-67 — server-driven `durable:false` warning naming `UPLOAD_DIR`/S3; the banner itself is fine but it is a live "not done" signal: if the deployed API still has no volume, every photo/document is lost on deploy. Left: confirm prod storage; not a web change.
- **No-op `onCreated`** — apps/web/src/pages/recruiting/RecruitingHome.tsx:1124 `onCreated={() => undefined}` on a create dialog — the parent ignores the created record (relies on query invalidation inside the dialog?). Left: verify the list refreshes after create; otherwise wire the callback. (ProviderManageDrawer.tsx:112 `onOpenChange={() => undefined}` is a closed-drawer sentinel, fine.)

Not unfinished, checked and cleared: `DriverTools.tsx:440 alert()` is the local SOS function,
not `window.alert`; "Not yet active" in AgentCards.tsx:113 / AgentRegistryAdmin.tsx:610 is a data
state; the `disabled` + `cursor-not-allowed` sites (AdminCommsView.tsx:802 channel buttons,
PeopleDirectory.tsx:5447 missing file, SecondRoleDialog, I9Tab, ApplicationDetail) all carry a
reason/title and are gated on data, not stubs.

## 2. Tests — skipped / todo

Unit (vitest, `src/**/*.test.{ts,tsx}`): no `it.skip`/`it.todo`/`describe.skip` literals. The six
skips reported by the runner all come from one dynamic test, the hotel-tenant forbidden-words
sweep, which skips surfaces "owned by another builder this round":

- **Organization profile** — apps/web/src/__tests__/tenancy/forbiddenWords.test.tsx:347 — `skip: 'exempt by the owner (2026-10-13): it names the module catalog'`; /admin/organization is allowed to say "client"/"staffing". Left: nothing unless the exemption should become an allowlist entry instead of a skip.
- **celebrations, assets, ramp (TALENT), expirations (INSIGHT), design-system ("the product standard, quoted verbatim"), org, org-units (STRUCTURE)** — forbiddenWords.test.tsx:427-437 `OWNED_ELSEWHERE` → :448 `(owned ? it.skip : it)` — pages another builder was "rebuilding this round"; `org` (/org) and `org-units` (/admin/org-units) are also in the hand-picked list so they never reach this loop, which is why the runner counts 6 not 8. The "this round" is over (the rebuilt pages are in the tree) but the skips still stand, so the hotel tenant can again be shown staffing words on Celebrations, Assets, Ramp and Expirations without CI noticing. Left: delete the four TALENT/INSIGHT entries from `OWNED_ELSEWHERE` and fix whatever words the sweep then finds; keep `design-system`.

e2e (Playwright) — 11 whole-file `test.skip(!process.env.E2E_FULLSTACK …)` gates: design-walk,
hotel-journey, safari-history (E2E_WEBKIT), associate-mobile, overflow-diag, tablet-shots,
grid-layout, axe-sweep (A11Y_SWEEP), visual-walk, polish-walk (apps/web/e2e/*.spec.ts). These
need the API dev server and never run in the default `playwright` invocation; not unfinished code,
but worth knowing that the only e2e coverage that runs by default is whatever is not gated.

## 3. Dead or orphan code

Files nothing imports (2) plus one dead at runtime:

- **lib/decisionsApi.ts** — apps/web/src/lib/decisionsApi.ts:1-45 — `useMyDecisions`, `countDecisions`, `myDecisionsKey` for `GET /me/decisions` with severity counts for the "Needs you" badge; zero importers. The badge now comes from `/me/inbox` (lib/inboxApi.ts:12) and the decision list from components/RoleDecisionQueue.tsx:118, which calls `/me/decisions` inline. Left: delete the file (or make RoleDecisionQueue use it).
- **lib/useFieldglassSetupCount.ts** — apps/web/src/lib/useFieldglassSetupCount.ts:11 — nav badge hook for `/finance/fieldglass?view=count`; zero importers (nav counts come from /me/inbox per the doors model). Left: delete.
- **pages/ModulePlaceholder.tsx** — imported by App.tsx:18 but `PLACEHOLDER_MODULES` is empty (see §1). Left: delete with its registration block.

Exported API-client functions with no caller outside tests (66 across 160 lib/*Api.ts files; the
ones that matter are where the server has the route and the UI never grew the control):

- **payrollApi local tax rules** — apps/web/src/lib/payrollApi.ts:700-712 `listLocalTaxRules`, `createLocalTaxRule`, `setAssociateLocalTaxRule` — server routes exist (apps/api/src/routes/payroll.ts:2831-2873) and are PROCESS-gated; no page lists or assigns local (city/county) tax rules, so a payroll admin can't set one without the API. Left: a Local tax rules section under payroll taxes.
- **payrollApi new-hire report** — payrollApi.ts:539-551 `getNewHireReport`, `downloadNewHireReportCsv`, `markNewHiresReported` — server routes exist (payroll.ts:2907-2950); superseded by lib/payComplianceApi.ts (`/pay-compliance/new-hire-reports`) which the UI uses. Left: delete the three functions.
- **payrollApi payroll schedules CRUD** — payrollApi.ts:260-275 `createPayrollSchedule`, `updatePayrollSchedule`, `deletePayrollSchedule`, `assignPayrollSchedule` — superseded by lib/paySchedulesApi.ts (rule-based membership; "never write Associate.payrollScheduleId directly"). Dangerous to leave: `assignPayrollSchedule` writes the direct assignment the rules model forbids. Left: delete.
- **payrollApi.approvePayrollRun** — payrollApi.ts:599 `POST /payroll/runs/:id/approve` — the review gate (payrollReviewApi `review/sign`) replaced it; the server route still exists (payroll.ts:1886). Left: delete the client function; confirm the server route is still wanted.
- **schedulingApi.declineMyShift** — apps/web/src/lib/schedulingApi.ts:156 `POST /scheduling/me/shifts/:id/decline` — route exists; MyShiftHero.tsx only shows a "declined" note derived from the attendance ask (`ask.answer === 'NO'`), there is no decline button. Left: decide whether associates may decline an assigned shift from the hero; if yes wire it, if no delete the function and route.
- **schedulingApi.saveRosterOrder** — schedulingApi.ts:469 `/scheduling/roster-order` — route exists; nothing in the scheduler persists a drag order. Left: wire into the roster or delete.
- **vto130Api.setVtoPolicy** — apps/web/src/lib/vto130Api.ts:104 `PUT /vto-policy` — VtoHome.tsx only calls `getVtoPolicy`; the policy is read-only in the UI. Left: a policy editor on VtoHome.
- **skills111Api claim/verify/delete/listAssociateSkills** — apps/web/src/lib/skills111Api.ts:54-75 — server has all four routes (skills111.ts:95-150); SkillsHome.tsx and CareerHome.tsx import the file but only use the skill catalog. Associates can't claim a skill and managers can't verify one. Left: the claim/verify flow.
- **worktags95Api assignments + report** — apps/web/src/lib/worktags95Api.ts:63-81 `assignWorktags`, `getAssignments`, `removeAssignment`, `worktagsReport` — routes exist; WorktagsHome.tsx manages categories/values only, nothing is ever tagged. Left: an "assign worktag" control on the entities and the report page.
- **learningPaths114Api.listMyLearningPaths / getLearningPathStatus** — apps/web/src/lib/learningPaths114Api.ts:141-146 — routes exist; no associate-facing "my paths" view. Left: associate view.
- **lms94Api.listModules / addModule** — apps/web/src/lib/lms94Api.ts:82-85 `/courses/:id/modules` — routes exist; LearningHome has no course-module editor. Left: module list in the course drawer.
- **earnedWageApi.listMyEarnedWage** — apps/web/src/lib/earnedWageApi.ts:46 `/me/earned-wage/history` — route exists; AssociatePayrollView shows the EWA offer but no history. Left: history list.
- **regionsApi.updateRegion / deleteRegion** — apps/web/src/lib/regionsApi.ts:92-104 — routes exist (region.ts:237, :313); RegionHome has no edit/delete. Left: edit + delete controls.
- **qualApi shift requirements** — apps/web/src/lib/qualApi.ts:88-97 `listShiftRequirements`, `addShiftRequirement`, `removeShiftRequirement` → `/shifts/:id/qualifications` — the server has NO such route (only `GET /qualifications`, qualifications.ts:160); also `listAssociateQuals`/`revokeAssociateQual` (:66-83) uncalled. Dead on both sides. Left: delete, or build shift-level qualification requirements end to end.
- **dirCommsApi.submitSurveyResponse** — apps/web/src/lib/dirCommsApi.ts:176 `POST /surveys/:id/responses` — the server has no such route (surveys live under `/pulse-surveys`, pulseSurveys109.ts). Dead on both sides. Left: delete.
- **transportApi.listVans / getDriverShifts / transportChargesCsvUrl** — apps/web/src/lib/transportApi.ts:670, :892, :1018 — routes exist (`/transport/vans`, `/transport/driver/shifts`); no caller. Left: delete or wire (the charges CSV would be a cheap "export" button on the charges table).
- **Smaller uncalled exports** (route exists, UI never used it): apiKeysWebhooks93Api.listWebhookDeliveries (webhook deliveries log not shown), integrationsApi.listIntegrationRuns, docTemplatesApi.listRenders, customFieldsApi.listValues, holiday117Api.listUpcomingHolidays, probation116Api.listEndingSoon, assets108Api.listAssetAssignments, benefitsLifecycle92Api.upsertAcaMonth, career126Api.updateLevel, compApi.getCurrentRecord, complianceScorecardApi.listAttestationSignals, financialChangesApi.getFinancialChange, internalMobility120Api.getInternalJob, opsApi.listOpsShifts, orgApi.getAssociateAsOf/unitDepth/setOrgUnitSites/listOrgUnitSites, payComplianceApi.issuePayNotice, payRulesApi.updatePremiumPayRule, paySchedulesApi.deletePaySchedule, payrollTaxesApi.listRegistrations, performanceApi.updateReview, robotsApi.createChecklistTemplate, tasksApi.assignTask. Left: a delete pass, keeping the ones a planned screen will use.
- **Test-only exports (15)** — agentsApi.getAgentApproval/decideAgentApproval, books/bankApi.updateBankAccount/getTxnSuggestions, closeApi.deleteBudget, ledgerApi.BOOKS_KEY, payablesApi.listBillPayments, receivablesApi.getClientReceivables/getPostingGaps, holiday117Api.importUsFederalHolidays2026, programsApi.getProgram/listProgramAlerts, seasonPlansApi.getSeasonPlanDefaults, usersAdminApi.getUserCounts, workersApi.getWorker — only `__tests__` reference them, i.e. the tests mock functions the pages don't call. Left: either wire or drop from the mocks.

Thin routes: every page under 60 lines is a legitimate role switch or shell
(PerformanceHome 11, SchedulingHome 13, SettingsArea 21, PayrollHome 31, DocumentsHome 37,
DecisionOpen 52, TimeOffHome 55, CommunicationsHome 59) — none renders only an EmptyState.
modules.ts vs App.tsx: all 150 module entries (145 distinct paths) have an explicit route; none
is orphaned.

## 4. i18n and design-lint debt

`i18n-check`: 2171 associate keys, en=es=3720, tr=2636, ht/pt/uk=2363, hard-coded debt 109,
all inside the baseline. The 109 literals by file (associate-facing per scripts/i18n-associate-files.txt):

- **Settings.tsx (20)** — apps/web/src/pages/Settings.tsx:87,100,468-516,619-629,816,830,1140,1202-1209,1328,1338,1533-1558 — account/2FA/recovery-code/email/password/timezone/language labels every associate sees in English. Highest-traffic debt in the list.
- **LearningHome.tsx (33)** — apps/web/src/pages/learning/LearningHome.tsx:80-939 — search/filter/status/empty-state/new-course/mark-complete/waive strings; the associate side ("Required", "No enrollments", "Window") shares the file.
- **KbHome.tsx (15)** — apps/web/src/pages/kb/KbHome.tsx:308-720 — article search/filter/status and the editor fields.
- **MarketplaceHome.tsx (14)** — apps/web/src/pages/marketplace/MarketplaceHome.tsx:90-835 — "Pending claims", "Qualifications", "Reject claim", new-qualification form.
- **AgreementsHome.tsx (9)** — apps/web/src/pages/agreements/AgreementsHome.tsx:196-625 — issue/delete agreement form.
- **ReimbursementsHome.tsx (7)** — apps/web/src/pages/reimbursements/ReimbursementsHome.tsx:286-1000 — search, approve, settle, waiver justification, "Travel".
- **TimeHome.tsx (2)** — apps/web/src/pages/time/TimeHome.tsx:109,117 — "Your own clock"/"Your clock" headings on the associate time page.
- **WhatsNewPage.tsx (2)**, **WhatsNew.tsx (1)** — :169,:222 / components/WhatsNew.tsx:102 "Dismiss what's new".
- **ShiftLeadsCard.tsx (1)** — apps/web/src/components/ShiftLeadsCard.tsx:145 "Floor supervisors:" (floor role).
- **MyDiscipline.tsx (1)** — :185 "Signature".
- **False positives (4)** — SwapMarketplace.tsx:101 `Promise`, RideHome.tsx:1683 `Math.abs(...)`, RideStrip.tsx:53 `SOON.includes(...)`, J1DocsTask.tsx:322 `N#########` (a format mask) — code caught by the `>Capitalised text<` heuristic; add to scripts/i18n-allowlist.json to make the real count 105.

`design-lint` (all equal to baseline): raw-heading 143 in 74 files, hex 33 in 9, empty-text 19
in 19, loading-text 4 in 4, pill 37, brand-text 1507. Files behind the four named debts:

- **raw-heading (`<h1/h2 className=`)** — portal/ClientPortalHome 9, WorkforceDashboard 6, portal/PortalHistory 6, org/OrgHome 5, transport/RideHome 5, transport/TransportHome 5, ConfirmEmailChange 4, careers/CareersPage 4, finance/FinanceCockpit 4, region/RegionHome 4, AcceptInvite/ForgotPassword/Install/Login/ResetPassword/offer/OfferLetterPage/onboarding/tasks/I9Task 3 each, 2 each: FinanceDashboard, documents/AssociateDocumentsView, integrations/DevelopersPage, learning/LearningHome, onboarding/ApplicationDetail, portal/PortalCandidates, PortalOps, PortalSchedule, PortalToday, scheduling/AssociateScheduleView, time/TimesheetHistory, transport/DriverHome, components/FloorTeam; 1 each in 44 more (AssociateDashboard, NotFound, RouterErrorPage, WhatsNewPage, analytics/AnalyticsHome, RetentionSection, approvals/ApprovalsHome, associate/MyShiftHero, audit/AuditHome, AuditIntegrity, compliance/ComplianceScorecard, DirectorateShell, headcount/HeadcountHome, hotline/HotlinePage, kiosk/KioskPage, marketplace/MarketplaceHome, onboarding/AssociateChecklist, TemplateEditor, TemplatesList, tasks/EsignTask, PolicyAckTask, ProfileInfoTask, org/CustomFieldsTab, PositionsTab, people/PeopleDirectory, portal/PortalRequests, recruiting/RecruitingAnalytics, relay/RelayBoard, RelayParts, scheduling/AdminApprovalPanels, AvailabilityEditor, LaborCostsHome, SwapMarketplace, time/AssociateTimeView, TimeHome, components/EmergencyBanner, FirstPaycheckCard, ProgramAlertsCard, ReadyToScheduleCard, ReadyToWorkCard, ShiftLeadsCard, Topbar, VanArrivals, templates/RecordTemplate). The public auth pages (Login/ForgotPassword/ResetPassword/AcceptInvite/ConfirmEmailChange/Install = 19) and the client portal (22) are the two clusters worth one sweep each.
- **hex colours** — components/transport/LiveMap.tsx 15 (map marker/route colours), scheduling/LaborCostsHome 5, admin/BrandingHome 3, transport/RideHome 3, Login 2, Settings 2, payroll/AssociatePayrollView 1, transport/DriverHome 1, transport/TransportHome 1. LiveMap is the one that needs a token-to-hex bridge for the map library; the rest are stray.
- **empty-text ("No … yet"/"Nothing …" literals instead of EmptyState)** — 1 each: admin/OrgUnitsAdmin, analytics/RetentionSection, approvals/ApprovalsHome, emergency/EmergencyHome, hotline/HotlineAdmin, onboarding/OnboardingAnalytics, ops/OpsBoard, ops/OpsRunner, payroll/FinancialChangesQueue, people/PeopleDirectory, platform/DesignSystemPage, pulse/PulseHome, recruiting/RecruitingAnalytics, relay/RelayRail, relay/RelayRequests, scheduling/DraftsDialog, scheduling/TemplatesRail, components/AuditTimeline, components/DecisionRoom.
- **loading-text ("Loading…")** — admin/AgentDecisionRecordTab, admin/AgentRegistryAdmin, people/PeopleDirectory, people/ProgramSection — should be Skeletons.

## 5. Feature flags / env toggles / settings without UI

- **VITE_SENTRY_DSN (+ VITE_SENTRY_TRACES_SAMPLE_RATE)** — apps/web/src/lib/sentry.ts:17-25 — Sentry is a no-op when unset; nothing in the repo (no .env.example in apps/web) documents it, so a prod build without it silently has no error reporting. Left: set in the deploy env or document.
- **VITE_FACE_MODELS_URL** — apps/web/src/lib/faceMatch.ts:96 — override for the face-api model CDN; defaults to the prebuilt path. Fine.
- **VITE_APP_VERSION** — pages/support/SupportPage.tsx:53 — sent with support tickets, null when unset.
- **import.meta.env.DEV** — pages/Login.tsx:30,455 (default dev email + dev-only block), RouterErrorPage.tsx:83, main.tsx:132 (service worker only in PROD). Fine.
- **Server-"configured" features surfacing as "coming soon"** — WhatsApp (`/whatsapp/me.configured`, see §1) has a settings surface (pages/settings/CommunicationsSettings.tsx:98 links to /communications?tab=whatsapp) but no place to enter the provider credentials — they are API env; the scorecard's ASN Nexus signals (§1) likewise depend on `ASN_NEXUS_BASE_URL`/`ASN_NEXUS_API_KEY` with no settings UI. Left: either an integrations card that shows "not configured — contact support" or env docs.
- **VTO policy** — read on pages/vto/VtoHome.tsx:11 via `getVtoPolicy`, never written (see §3 `setVtoPolicy`). A settings-driven feature whose settings UI doesn't exist.
- **Org-settings reads in web** — only `settings.locationMode` / `settings.classMode` (3 each); every other org toggle is read server-side, so no further flag-without-UI cases were found in the web.

## 6. Pages fetching endpoints that do not exist in apps/api

None reachable. All 2,032 `apiFetch`/`fetch('/api…')` call sites in apps/web/src resolve to a
mounted router path (after resolving `${B}`-style prefix constants and treating trailing
`${qs}` as query strings; dynamic-segment calls such as `/agents/approvals/:id/${decision}` and
`/books/reports/${kind}.${format}` were checked by hand against agents.ts:171 and ledger.ts:693).
Two client functions do target routes the server never had, but nothing calls them:

- **qualApi shift requirements** — apps/web/src/lib/qualApi.ts:88-97 → `/shifts/:id/qualifications` (GET/POST/DELETE) — no such route in apps/api/src/routes (qualifications.ts only serves `GET /qualifications`). Uncalled, so no page breaks. Left: delete or build.
- **dirCommsApi.submitSurveyResponse** — apps/web/src/lib/dirCommsApi.ts:176 → `POST /surveys/:id/responses` — no such route (pulseSurveys109.ts serves `/pulse-surveys` and `/my/pulse-surveys`). Uncalled. Left: delete.
