# Brief 2-1b — Tenant profiles and modules: investigation

Date: 2026-10-13. Status: report before coding. Nothing in this document changes data or code. Counts come from ripgrep over `apps/api/prisma/schema.prisma` (10,057 lines, 271 models, 257 migrations), `apps/api/src` (114 route files, 131 mounts in `app.ts`), `apps/web/src` and `packages/shared`. Line numbers are as of commit `e5bb0c14`.

Reading this with the 2-1 report (`docs/multi-tenancy-investigation.md`): that report put a `tenantId` on every row and a wall between tenants. This one is about what a tenant *is*: today the schema, the scope rules, the navigation and Hugo all assume a staffing company that places associates at a client's stores and bills the client. The hotel test tenant is none of those things.

## 1. Summary

1. **The staffing shape is in the keys, not just the words.** 32 models carry a required `clientId` (Location, Application, Shift, KioskDevice, Department, CostCenter, Position among them), 11 unique constraints are keyed on it, and `lib/scope.ts` fails closed on a missing `clientId` for three roles. A hotel with no Client cannot create a site, a shift, an application or a kiosk today. "Client is optional" is a schema change on about 12 models in the acceptance path plus a rewrite of the client-bounded scope rules to site/org-unit scope; the other 20 required `clientId` models belong to modules the hotel has off.
2. **Vocabulary is mostly hard-coded.** The web dictionary has 5,237 English keys (Spanish only; no Turkish in the web), but 2,202 distinct keys are used by `t()` and the nouns the brief names appear in about 2,990 string literals across 219 web files outside the dictionary, and about 1,600 quoted strings in the API. Hugo's text is centralized in three files (`whatsappContent.ts`, `emailContent.ts`, `emergencyContent.ts`, 790 lines, EN/ES/TR) and is the easy part; the WhatsApp templates say "the Alto app" and are registered with Meta per text.
3. **Module gating does not exist.** `Tenant.features` is a Json column nobody reads (zero readers in `apps/api/src`); `modules.ts` filters 87 modules by capability and by nine per-role key sets, never by tenant; crons run for the one org; Hugo offers RIDE to everyone. Every module in the brief maps cleanly to existing module keys, route mounts and crons (table in §5), so gating is a registry plus one middleware, one nav filter, one cron check and one Hugo filter.
4. **There is no org hierarchy and no employer-of-record record.** Region is a name with locations; Department (tree) and CostCenter (flat) hang off a Client; there is no division, business unit or GL code (the closest is `Worktag.code`). Employment is implied by an APPROVED Application at a Client plus `Associate.hireDate`/`separatedAt`; the employer on W-2s and 1099s is the Client's `legalName`/`ein` (`routes/payrollTax91.ts:1226`), which for a direct employer is the wrong row.
5. **Recommendation:** ship it in seven additive steps (§10). Order: profile + modules + terminology first (it is what the acceptance test reads), then optional Client on the hotel path with site/org-unit scope, then employer of record, then OrgUnit, then the hotel seed and acceptance test, then the Site rename as cosmetics. Six owner decisions gate the design (§9), the first two being whether to rename the `Location` table and whether a direct employer gets a hidden self-Client (recommended: no).

## 2. Where the schema assumes a staffing company

### 2.1 Required `clientId`: 32 models

| Model | schema.prisma | In the hotel acceptance path? |
|---|---|---|
| Location | 832 | **Yes** — the site itself; `client Client @relation(... onDelete: Restrict)` |
| Application | 2061 | **Yes** — onboarding; `@@index([clientId, status, …])` ×3 |
| Shift | 2986 | **Yes** — scheduling |
| ShiftTeam | 895 | Yes (scheduling teams) |
| SchedulingRosterOrder | 1540 | Yes; `@@unique([clientId, associateId])` :1547 |
| ClockInRequest | 1701 | Yes (time) |
| KioskDevice | 6783 | Yes (time) |
| KioskPin | 6835 | Yes (time) |
| ShiftPosition | 4482 | Yes (positions catalog) |
| ShiftRateDefault | 4457 | Yes (rate cards, 1A-2); `@@unique([clientId, position, effectiveFrom])` :4474 |
| Department | 4395 | Yes (org) ; `parentId` tree |
| CostCenter | 4423 | Yes (org) |
| Position | 4541 | Yes (org) |
| JobProfile | 4505 | Yes (org) |
| Offer | 5914 | Likely (recruiting → onboarding) |
| OpsShift | 2481 | No — Store Ops module |
| FieldglassTimesheet | 1040 | No — payroll sync (Fieldglass); `@@unique([weekStart, associateId, clientId])` :1065 |
| ClientRequest | 1092 | No — client portal |
| ClientAcknowledgement | 1253 | No — client portal; `@@unique([clientId, kind, subjectKey])` :1265 |
| ClientStatement | 1485 | No — bill rates and margin; `@@unique([clientId, periodStart, periodEnd])` :1509 |
| Job | 3104 | No — recruiting by client; `@@unique([clientId, name])` :3118, `billRate` :3109 |
| CandidateSubmittal | 3922 | No — staffing submittals |
| BenefitsPlan | 4287 | Benefits (not in the hotel acceptance list) |
| QuickbooksConnection | 4356 | No — `clientId @unique` (one QBO per client) |
| CompBand, MeritCycle | 4995, 5022 | Compensation |
| Project, PremiumPayRule, TipPool | 5380, 5401, 5424 | Pay rules; `@@unique([clientId, code])` :5394 |
| OshaIncident | 5674 | Compliance (OSHA) |
| OpenEnrollmentWindow | 6247 | Benefits |
| ReadyToWorkHandoff | 9165 | Onboarding → store handoff (client portal) |

A further 37 models have an optional `clientId` where null means "company-wide" (User, TimeEntry, PayrollRun, PayrollSchedule, Policy, OnboardingTemplate, Qualification, Holiday, …; see the 2-1 report §2.1). Those already work for a direct employer: a null client is the tenant.

Unique constraints keyed on `clientId` (11): schema lines 1065, 1265, 1509, 1547, 2183 (OnboardingTemplate `[clientId, track]`), 3118, 4474, 5394, 8446 (ComplianceScoreSnapshot `[day, clientId]`), 8500 (TimesheetFiling `[weekStart, clientId]`), 9334 (DriverClientAccess). PostgreSQL treats nulls as distinct in unique indexes, so making the column nullable on the hotel-path models silently allows duplicates (two rate cards for the same position on the same day) unless each becomes `[tenantId, …]` with a partial index for the null case, as the 2-1 report already planned for the "null client" tables.

### 2.2 Location is "the store"

`Location` (832) is modelled as a physical site under a Client (comment at 833: "Walmart → Destin / Front Beach / PCB"). Twenty-two models reference it; the ones named for stores: `StoreShiftSop` (2562), `User.locationId` with relation `UserStoreScope` (User 382, field at +65), `ClientRequest.locationId` relation `ClientRequestStore`, `StaffingTarget` (942, "contracted headcount"), `SupervisorShiftWindow`, `SeasonPlanSite` (9621, beds and van seats per site). The word "store" appears 59 times in the schema. `Location.clientId` is the only required link; `regionId` is optional (`Region` 1155, a name only). The only places a Location is created are `routes/clients.ts:253` and `:434` (both under a client) and `prisma/seed.ts:369`.

### 2.3 Employer facts on Client

`Client` (682–830) carries `weekStartsOn` (per-client scheduling week), `sutaRateOverride`, `sutaWageBaseOverride`, `legalName`, `ein`, `addressLine1/2`, `city`, `zip`, `state`, `fieldglassSiteName`, `fieldglassBillRate` (720). Twenty-two API files read `legalName`/`ein` (78 occurrences): `lib/paystubData.ts:202` falls back to `'Alto Etho LLC'`; `routes/payrollTax91.ts:1226, 1407, 1504` refuse to render a W-2, 1099-NEC or 1099-MISC when the client has no `legalName`/`ein`; `lib/efw2.ts`, `lib/w2Pdf.ts`, `lib/irsFire.ts`, `lib/eftpsWorksheet.ts`, `lib/garnishmentLetter.ts`, `lib/statementPdf.ts`. The 2-1 report's decision 3 (move employer identity to the tenant's `SubmitterProfile`) is a prerequisite of this brief: a hotel's payroll export must name the hotel.

### 2.4 Bill rates and margin

Schema: `Client.fieldglassBillRate` (720), `ClientStatement.marginTarget` (1521), `ClientRequest.estBillRate` (1678), `Job.billRate` (3109), `ShiftRateDefault.billRate` (4464, nullable beside the required `payRate`). Code: `config/env.ts:273-292` (`DEFAULT_*_BILL_RATE` 21.21/24.24, burden 12%), `routes/complianceScorecard.ts:66-106` (`WALMART_BILL_RATES`), `lib/financeCockpit.ts` (margin), `routes/financeOverview.ts`, `lib/statementPdf.ts`, `lib/clientServiceReport.ts`. Web: "bill rate" in 10 files (32 occurrences), "margin" in 19 (97); dictionary keys `fin.billUnpriced` (i18n.tsx:802), `fin.marginUnpriced` (:816). The rate card `ShiftRateDefault` is shared between pay (always on) and bill (module); the column stays, the UI column hides.

### 2.5 Housing

There is no housing model. What exists: `AgreementKind.HOUSING_AGREEMENT` (7556+), `SeasonPlan.housingShare` (9602) and `SeasonPlanSite.bedsAvailable` (9625, "Helios capacity by hand until a link exists"), `TransportStop` ("a housing complex", 8628), the housing policy text in `lib/altoHrContent.ts`, emergency "housing = address on file" in `lib/emergency.ts`. API files mentioning housing: 9 (`config/env.ts`, `altoHrContent.ts`, `emergency.ts`, `programs.ts`, `seasonPlanner.ts`, `seasonPlanPdf.ts`, `transport.ts`, `routes/programs.ts`, `routes/transport.ts`); web: 11 non-test files (season planner, programs, transport, headcount, onboarding e-sign). "Housing link" in the brief is therefore a flag with nothing behind it yet except the season planner's bed math and the e-sign agreement kind.

### 2.6 Transportation: 12 models, 2 roles, 1 payroll deduction

`TransportStop` 8629, `Van` 8646, `RideRejection` 8674, `RidePlace` 8691, `RideConsent` 8710, `TransportRate` 8736, `Ride` 8750 (`locationId` required, `fareCents`, `chargedItemId` → payroll), `RideRun` 8844, `TransportIssue` 8883, `RideRunPing` 8909, `TransportSettings` 8939 (singleton `default`), `DriverClientAccess` 9313. Roles `TRANSPORTATION_DIRECTOR` and `DRIVER` (`roles.ts:15-16`, descriptions name "the Alto vans"); capabilities `ride:transport`, `view:transport`. The ride deduction (Brief 1A-3) lives in payroll and must stay (owner mandate) but must be inert when the module is off. Emergency evacuation rides (`Emergency`, `EmergencySite` 9407) depend on it.

### 2.7 Programs: 7 models

`J1Profile` 2039 (one-way synced from Program), `Sponsor` 9468, `Program` 9497 (`petitionClientId` → Client, H-2B), `ProgramDocument` 9548, `ProgramAlertSetting` 9563 (singleton), `SeasonPlan` 9585, `SeasonPlanSite` 9621; `Associate.j1Status` 1773. Monday `programDigest` cron.

### 2.8 What "optional Client" breaks

- **Required FKs:** the 15 hotel-path models in §2.1 need `clientId String?` and `client Client?`; `Location.client` is `onDelete: Restrict`.
- **Unique constraints:** 5 on the hotel path (`SchedulingRosterOrder`, `ShiftRateDefault`, `Project`, `OnboardingTemplate`, `ComplianceScoreSnapshot`) need a `[tenantId, …]` form plus a partial null-client index.
- **`lib/scope.ts` fail-closed rules:** `NO_CLIENT` (:11) is returned for `CLIENT_PORTAL`, `SHIFT_SUPERVISOR` and `FLOOR_SUPERVISOR` with no `clientId` in `scopeClients` :24, `scopeApplications` :37, `scopeShifts` :113, `scopeAssociates` :210, `scopePayrollItems` :234, `scopeTimeOffRequests` :260, `scopeTimeEntries` :276, `scopeQualifications` :323, `scopeQualificationWrites` :341, `effectiveClientIdFilter` :389. A hotel's shift supervisor has no client and today would see nothing. `atClient` :167 and `associatesOfClient` :148 define "this client's people" by open assignment at a location of the client or an APPROVED application at the client; `atStore` :201 (open assignment at the location) is the rule that already works without a client.
- **`lib/activeDefinition.ts`:** `Placement.clientId: string` (:53-58) and `clientOfLocation` (:66-68) assume every placement resolves to a client; `activeInventory.ts` lists the 60 sites that read it.
- **Kiosk:** `routes/kiosk99.ts:94-105` already accepts `locationId` in place of `clientId` ("clientId or locationId is required") — the precedent for the rest.
- **Payroll:** `PayrollRun.clientId` and `PayrollSchedule.clientId` are already optional (`routes/payroll.ts:415-653` runs per schedule with null = company-wide); `lib/reconcilePayroll.ts:210` aggregates with `clientId: null`. Payroll and the reconciliation report work without a client; only the employer identity on the forms (§2.3) does not.
- **Test fixtures:** `apps/api/test/db.ts:203` `createClient` creates the default Location; every API test that needs a site goes through a client.

## 3. Where the code assumes a client

### 3.1 Counts

| Measure | Count |
|---|---|
| API files (routes + lib) referencing `clientId` | 158 (74 route files of 114; 84 lib files); 2,572 occurrences outside tests |
| Files whose scope depends on `req.user.clientId` or the `scope.ts` helpers | 30 |
| Web files referencing `clientId` | 199 |
| Web files mentioning Fieldglass or Walmart | 62 |
| API files mentioning Fieldglass | 25; Walmart 19; Synchros 2 (`lib/bulkPiiExport.ts`, `lib/reconcilePayroll.ts`) |
| Migrations seeding Walmart data | 5 |

Scope-dependent files by occurrence: `routes/scheduling.ts` 45, `lib/scope.ts` 34, `routes/time.ts` 17, `routes/auth.ts` 16, `routes/opsShifts.ts` 13, `routes/clients.ts` 9, `routes/clientPortal.ts` 9, `routes/kiosk99.ts` 8, `routes/holiday117.ts` 8, `routes/qualifications.ts` 7, `routes/clientRequests.ts` 5, `routes/analytics.ts` 5, `lib/roleDecisions.ts` 5, then 17 files with 1–4 (`transport.ts`, `projectsAndPay.ts`, `onboarding.ts`, `jobs.ts`, `search.ts`, `org.ts`, `messages.ts`, `approvals.ts`, `lib/portalReadiness.ts`, `lib/portalInvite.ts`, `lib/messaging.ts`, `lib/activeInventory.ts`, `lib/shiftAutofill.ts`, `lib/readyToWork.ts`, `lib/noShowRisk.ts`, `lib/associateClients.ts`, …).

### 3.2 Roles

`packages/shared/src/roles.ts`: 15 roles (:1-17), 42 capabilities, `CLIENT_PORTAL` holds four view capabilities (:331-336). `CLIENT_BOUNDED_ROLES` = `SHIFT_SUPERVISOR`, `FLOOR_SUPERVISOR`, `CLIENT_PORTAL` (:516-520, `isClientBoundedRole` :522, `boundedClientOf` :528). `additionalRoleRefusal` (:638-652) makes CLIENT_PORTAL the tenant boundary for role switching. Role descriptions name "one client", "the Alto vans", "all stores" (:41-63). `User` carries `clientId` (382+59), `locationId` (+65, the store pin) and `regionId` (+69, the command center).

### 3.3 The client portal

`routes/clientPortal.ts` 1,922 lines, `routes/clientRequests.ts` 338, `routes/region.ts` 318, `routes/regions.ts`, `routes/clients.ts` 1,282 (with `clientsAccessGate`, `app.ts:389`), `lib/portal*.ts` eight files (`portalDayReport` 1,674, `portalOps` 731, `portalMetrics` 472, `portalEngagement` 423, `portalCoverageAlert` 308, `portalDigest` 237, `portalInvite` 216, `portalReadiness` 158), `lib/storeSnapshot.ts` 236. Web: 15 pages under `pages/portal`, module keys `portal`, `portal-today`, `portal-ops`, `portal-schedule`, `portal-history`, `portal-requests`, `portal-candidates`, `region` (modules.ts:424-495), and `visibleModules` special-cases `CLIENT_PORTAL` (:365-412). Crons: `portalDigest`, `portalEngagementDigest`, `portalCoverageAlert`, `serviceReportMail`, `readyToWorkNudge`. Messenger store channels (`lib/messaging.ts`). The portal is, by construction, the "client portal" module: everything behind `CLIENT_PORTAL` and the Clients page.

### 3.4 Vendor-specific code

Fieldglass: `lib/fieldglassDesk.ts`, `fieldglassNotify.ts`, `fieldglassPacket.ts`, `fieldglassQueue.ts`, `fieldglassSecurityId.ts`, `timesheetXlsx.ts`, `timesheetWeek.ts` (Saturday week), `timesheetHistory.ts`, `asnNexus.ts`, `manualAttestation.ts`, 20 references in `routes/time.ts`, modules `fieldglass` and `fieldglass-setup` (modules.ts:1026-1046), models `FieldglassRegistration` (1009) and `FieldglassTimesheet` (1035). Walmart: `lib/opsSopsWalmart.ts`, `routes/complianceScorecard.ts:66-106`, `lib/altoHrContent.ts`, `app.ts`, `config/env.ts`, `routes/drugTests.ts`, `routes/docTemplates.ts`, i18n comment "Client portal — the Walmart view" (i18n.tsx:573). Synchros: the 1A-1 reconciliation only.

## 4. Vocabulary

### 4.1 The dictionary

`apps/web/src/lib/i18n.tsx` (5,763 lines): hand-rolled, `Lang = 'en' | 'es'` (:24), `en` :28-2874 (5,237 keys), `es` :2875-5694, falls back to English. `t()` is called 2,761 times in `.tsx` with 2,202 distinct keys, so about 3,000 dictionary keys are unused or used dynamically. Admin surfaces "stay English for now" (:21) — which is where most of the hard-coded nouns are.

### 4.2 Where the nouns are today

Whole-word, case-insensitive counts.

| Noun | i18n.tsx keys | Web outside i18n (occurrences / files) | …of which inside string literals or JSX text (tsx, no tests) | API routes+lib (occurrences / files) | …inside quoted strings | Hugo files (WA / email / emergency) |
|---|---|---|---|---|---|---|
| associate(s) | 29 | 1,499 / 258 | 737 | 3,461 / 231 | 605 | 3 / 5 / 0 |
| store(s) | 73 | 1,114 / 178 | 315 | 1,019 / 119 | 174 | 4 / 0 / 0 |
| client(s) | 29 | 1,463 / 267 | 658 | 2,593 / 257 | 567 | 0 / 1 / 0 |
| supervisor | 29 | 274 / 76 | 102 | 300 / 60 | 93 | 8 / 0 / 0 |
| manager | 26 | 251 / 89 | — | 276 / 70 | — | 2 / 0 / 0 |
| van(s) | 63 | 512 / 42 | 197 | 281 / 25 | 81 | 18 / 0 / 4 |
| ride(s) | 523 | 1,242 / 43 | 917 | 474 / 30 | 89 | 6 / 0 / 0 |
| housing | 3 | 54 / 18 | 45 | 82 / 8 | 8 | 0 |
| bill rate | 3 | 32 / 10 | 16 | 18 / 10 | — | 0 |
| margin | 3 | 97 / 19 | — | 128 / 36 | — | 0 |
| region | 140 | — | — | — | — | — |
| site / location / employee / worker / team member / property | 7 / 6 / 2 / 1 / 0 / 0 | — | — | — | — | — |

Capitalized JSX text alone (`>…Associate…<` or quoted): Associate 140, Client 70, Van 48, Store 40, Housing 34, Supervisor 6, Bill rate 2. The occurrence columns include identifiers (`clientId`, `associateId`), so the honest estimate of **user-facing hard-coded strings to route through a terminology table is about 2,990 in the web (219 files) and about 1,600 in the API** (notification subjects and bodies at 295 `notify*` call sites, validation messages, PDF labels, role descriptions in `roles.ts`). The ride vocabulary dominates (917 web strings) and is entirely inside the transportation module, so it is hidden rather than translated.

### 4.3 Where Hugo's text lives

- `lib/whatsappContent.ts` (290 lines): nine Meta templates `alto_notice`, `alto_shift_assigned` (params `position, store, when`), `alto_shift_changed`, `alto_shift_cancelled`, `alto_shift_reminder`, `alto_ride_pickup`, `alto_ride_near`, `alto_payday`, `alto_emergency`, each EN/ES/TR, each saying "the Alto app"; `WA_REPLY` (:178-281) with 13 replies (`intro`, `whoAmI`, `optedIn`, `payday`, `noPayday`, `ride`, `noRide`, `schedule`, `noShifts`, `handoff`, …). The assistant's name is already a parameter (`getBrandingSync().assistantName`, `whatsappAssistant.ts:211-214`).
- `lib/whatsappAssistant.ts`: intents `OPT_OUT`, `OPT_IN`, `LANGUAGE`, `WHO`, `PAYDAY`, `RIDE`, `SCHEDULE`, `HANDOFF` (:58-71); `answerRide` (:89) reads rides and vans.
- `lib/emailContent.ts` (395 lines, EN/ES/TR through `emailLayout.ts`), `lib/emergencyContent.ts` (105 lines; "van" ×4). The 26 legacy templates in `lib/emailTemplates.ts` are not yet on the shared layout (memory: owner approval pending).
- Hugo's capabilities are the three answer intents plus handoff; the brief's "capability not offered when its module is off" is one line in `detectIntent`/the switch for RIDE, and the removal of the two `alto_ride_*` templates and the `ride:transport` capability from the hotel's role matrix.

### 4.4 What a terminology table has to feed

Three nouns (worker, site, manager) in singular/plural and EN/ES(/TR), plus the top-30 labels. The labels that exist as keys today and would simply read from the profile: `portal.title` "My store" (:821), `region.*` (140 keys), `wf.*` ("All stores green" :602, "The supervisor corps" :624, "Store Ops" :634), `opsRun.*` (store/supervisor/client :78-113), `fin.fgClient` (:712), `portal.reqKindFeedback` "Feedback about an associate" (:671), `msg.*` store channel (:943-960), the module labels in `modules.ts` ("My store" :426, "Store operations" :444, "Store Ops" :944, "Clients" :854, "Client statements" :1049, "Fieldglass timesheets" :1028, "Ride" :899, "Transportation" :908), the role labels and descriptions (`roles.ts:21-63`), the dashboard card titles, and the WhatsApp `store` parameter. The rest (the 2,990 + 1,600 literals) is a sweep: each literal either becomes a `t()` key that interpolates the noun, or is inside a module that is hidden for the hotel and can wait.

## 5. Modules

### 5.1 What exists for gating today

- `Tenant.features Json @default("{}")` (schema, Tenant model) — **zero readers** in `apps/api/src`; `Tenant.plan` likewise.
- `apps/web/src/lib/modules.ts` (1,290 lines): 87 module keys, `ModuleNav { key, path, label, description, requires, requiresAny?, group }` (:124-137), seven groups (core 12, workforce-management 37, operations 2, compliance 11, payroll-finance 14, client-services 4, platform 7), `visibleModules(role, can, scope)` (:365-412) filters by capability and then by nine hard-coded per-role key sets (`CLIENT_PORTAL_MODULE_KEYS`, `FINANCE_MODULE_KEYS`, `WORKFORCE_MODULE_KEYS`, `RECRUITER_MODULE_KEYS`, `EXEC_MODULE_KEYS`, `SHIFT_SUPERVISOR_MODULE_KEYS`, `FLOOR_SUPERVISOR_MODULE_KEYS`, `ASSOCIATE_MODULE_KEYS`, `TRANSPORT_DIRECTOR_MODULE_KEYS`, `DRIVER_MODULE_KEYS`). Consumers: `Sidebar.tsx` (:145 groups by `m.group`), `MobileNav.tsx`, `CommandPalette.tsx`, `App.tsx` (138 routes), `moduleIcons.ts`.
- Capability matrix: `roles.ts` `ROLE_CAPABILITIES`, 15 × 42; `requireCapability` on API mounts (`app.ts:395, 405, 488, 496`).
- Env: about 25 cron cadence variables where `0` disables (`config/env.ts:119-271`), `TENANCY_MODE` (:407), SSO vars (:454). These are deployment switches, not tenant switches.
- Crons: 44 `start*Cron()` calls plus two `setInterval` sweeps in `index.ts:94-170` (46), none tenant-aware (2-1 §5).

### 5.2 Brief module → module keys → API → crons → Hugo

| Brief module | modules.ts keys | API mounts / routers (`app.ts`) | Crons (`index.ts`) | Hugo / notifications |
|---|---|---|---|---|
| scheduling | scheduling, marketplace, approvals, holidays, labor-costs | schedulingRouter (:400), holiday117Router (:590), approvals | shiftReminder, scheduleDigest, weekAhead, shiftAutofill, noShowRisk | SCHEDULE intent; `alto_shift_*` templates |
| time | time-attendance, timesheets, kiosk, time-off | `/time` (:395), `/time-off`, kiosk99Router (:579) | autoClockOut, kioskMaintenance | clock-out reminders |
| HR cases | hr-cases, discipline, hotline | hrCases123Router (:596), hotline, discipline | — | case notifications |
| compliance | compliance, documents, doc-templates, expirations, vaccinations, agreements, audit, payroll-compliance, programs (shared) | complianceScorecard, documents, everify, auditPacket, `/audit`, `/audit-packets` | attestationReminder, expirationDigest, complianceSnapshot, documentMaintenance | expiration notices |
| payroll sync | fieldglass, fieldglass-setup, integrations (QuickBooks), billing | fieldglass routes in `routes/time.ts`, `/quickbooks` (:624), `/external-payments` (:504), `/integrations/v1` (:367) | webhookDelivery | Fieldglass handoff notification (Finance) |
| housing link | — (none) | — | — | — |
| transportation | rides, transport, emergency (evacuation rides) | `/transport` (:615), `/emergency` (:442, partly) | vanTrailRetention | RIDE intent, `alto_ride_pickup`, `alto_ride_near`, emergency van text; roles TRANSPORTATION_DIRECTOR, DRIVER; `ride:transport` capability; ride deduction in payroll |
| programs | programs, season-planner | `/programs` (:447), `/season-plans` (:450) | programDigest | sponsor/program alerts |
| bill rates and margin | statements, billing, labor-costs (margin half), analytics (finance) | financeOverviewRouter (:570), statements, `ShiftRateDefault.billRate`, `Job.billRate` | serviceReportMail (statement half) | — |
| client portal | portal ×7, region, regions, clients, messages (store channels), dircomms, communications | `/clients` (:389), `/region` (:387), `/regions` (:388), clientPortalRouter (:569), clientRequestsRouter (:575), `/messages` (:384), readyToWork | portalDigest, portalEngagementDigest, portalCoverageAlert, serviceReportMail, readyToWorkNudge | portal mute buckets, store channel sync |
| robotics | workers (`WorkerType` ROBOT, `pages/admin/WorkerTypesAdmin.tsx`) | `/workers` | sweepWorkers (15 min) | — |
| agent builder | agents (registry; no builder exists) | `/agents` (:453), `/agent/v1` (:369) | sweepAgents, agentDrift | Hugo himself is an AGENT worker |

Payroll itself (payroll, payroll-tax, payrules, compensation, benefits, reimbursements) is not in the brief's module list and stays always-on; "payroll sync" reads as the integrations row above (decision 6 in §9).

### 5.3 What "module off" must hide

1. **Navigation:** `visibleModules` gains a `modules` argument from the tenant profile and filters before the role sets; `CommandPalette`, `MobileNav`, dashboard cards and the "Pinned" rail follow because they read the same list.
2. **Routes:** a `requireModule('transportation')` middleware on the mounts in the table (404, not 403, so an off module is indistinguishable from absent), plus the routes mounted at `/` that gate per route (clientPortal, clientRequests, kiosk99, hrCases123, financeOverview). The cross-tenant suite (`src/__tests__/tenancy/crossTenant.test.ts`) already enumerates every mounted route from the router; the same enumeration gives the "module off → 404" suite for free.
3. **Hugo:** `detectIntent` returns HANDOFF for RIDE when transportation is off; the ride templates are not registered for the tenant; the `ride:transport` capability is dropped from the role matrix when the module is off (`hasCapability` gains the module check, or the web `can()` does).
4. **Crons:** each per-tenant iteration (2-1 §9.4) checks the profile before running; the eight crons in the transportation/programs/portal/bill-rate rows skip the hotel.
5. **Data columns in shared screens:** `billRate` on the rate card, `fareCents`/ride deduction on paystubs, "store" columns in reports, the Fieldglass columns on timesheets, `Client` filters on every list (`effectiveClientIdFilter` returns undefined and the UI hides the picker).
6. **Roles:** `TRANSPORTATION_DIRECTOR`, `DRIVER`, `CLIENT_PORTAL` are not offered in Users & access when their module is off (Brief 2-3 makes roles tenant-defined; until then, a filter on `HUMAN_ROLES`).

## 6. Organizational hierarchy

### 6.1 What exists

| Thing | Where | Shape |
|---|---|---|
| Region | schema 1155; `routes/regions.ts`, `routes/region.ts`; `User.regionId`; `Location.regionId` | A name. Stores roll up to it across clients; a `CLIENT_PORTAL` user with `regionId` and no `clientId` is the command-center account (`modules.ts:367`, `lib/scope.ts` fails closed on null clientId) |
| Client → Location | 682, 832 | Two levels, required |
| Department | 4393 | Per client, `parentId` tree, `code`; `Associate.departmentId`, `Position.departmentId`, `Broadcast`, `PulseSurvey` audiences |
| CostCenter | 4421 | Per client, flat, `code`; `Associate.costCenterId`, `Position.costCenterId` |
| Position / JobProfile | 4539 / 4505 | Per client; manager, FTE, rate band |
| Worktag / WorktagCategory / WorktagAssignment | 6523-6559 | Workday-style tags on TIME_ENTRY, PAYROLL_ITEM, EXPENSE, PURCHASE_ORDER; `Worktag.code` is the only "GL code"-shaped field |
| User scope | 382 (+59, +65, +69) | `clientId`, `locationId` (store pin), `regionId` (command center) — three disconnected scope pins |
| GL code, division, business unit | — | **None.** `grep -i "glCode|generalLedger"` finds nothing |

### 6.2 Proposed model

```prisma
enum OrgUnitType { DIVISION REGION BUSINESS_UNIT COST_CENTER }

model OrgUnit {
  id        String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId  String      @db.Uuid
  type      OrgUnitType
  parentId  String?     @db.Uuid
  name      String      @db.VarChar(160)
  code      String?     @db.VarChar(40)   // the unit's own code
  glCode    String?     @db.VarChar(40)   // the ledger account it posts to
  path      String      // materialized: "/div/region/bu" for ancestor checks in one WHERE
  clientId  String?     @db.Uuid          // a staffing tenant's client-specific units
  legacyRegionId String? @unique @db.Uuid // bridge from Region
  isActive  Boolean     @default(true)
  deletedAt DateTime?
  @@unique([tenantId, parentId, name])
  @@index([tenantId, type]) @@index([path])
}
```

- `Location.orgUnitId` (optional, SetNull); `Associate.orgUnitId` (home unit); `Position.orgUnitId`; `CostCenter` rows become `OrgUnit(type: COST_CENTER)` with `clientId` kept, `Associate.costCenterId`/`Position.costCenterId` re-pointed by migration, the `CostCenter` table left in place until a later drop. `Department` stays as the job-structure tree (it is audience and reporting-line, not ledger) — decision 5.
- **Permission at any level:** `User.orgUnitId` (one pin, nullable). `lib/scope.ts` gains `scopeByOrgUnit(user)`: a row is visible when its site's `OrgUnit.path` starts with the user's unit's path. `locationId` remains the leaf case (a store manager is a user pinned to a site); `regionId` becomes "pinned to an OrgUnit of type REGION". The three pins collapse to `orgUnitId | locationId` with `clientId` only meaningful for WORKFORCE_PROVIDER tenants.
- **Coexistence with Region:** step one creates one `OrgUnit(REGION)` per Region row (`legacyRegionId`), and `routes/region.ts` + `lib/storeSnapshot.ts` keep reading `Region` until the command center reads OrgUnit; `User.regionId` is backfilled to `orgUnitId`. Region is dropped last, after the portal's e2e passes on OrgUnit.
- **Both business models use it:** a direct employer's hotel chain is Division → Region → Property (site); a staffing tenant's units are its own regions and cost centers, and `OrgUnit.clientId` lets a client-specific cost center live in the same tree (the "staffing scoping" the brief asks for).

## 7. Employer of record

### 7.1 Where employment is recorded today

| Fact | Where | Note |
|---|---|---|
| Hired | `Application.status = APPROVED` at a Client (2058); `Associate.hireDate` (1808, stamped from the approve dialog; `routes/onboarding.ts:510, 951`) | An application names a client, not an employer |
| Placed | `AssociateAssignment` (1725: associate, location, startedAt, endedAt) | Placement, not employment; `WorkerAssignment` (9785) is the 1D-1 twin |
| Employment type | `Associate.employmentType` (1776: W2_EMPLOYEE, CONTRACTOR_1099_INDIVIDUAL, CONTRACTOR_1099_BUSINESS) | Per associate, not per spell |
| Pay | `CompensationRecord` (4969: effective-dated, payType, amount) | Money only |
| Offer | `Offer` (5914, `clientId` required) | Pre-hire |
| Separated | `Separation` (lastDayWorked, …), `Associate.separatedAt` (1849) | The end of the spell |
| Employer identity | `Client.legalName/ein/address/suta*` (§2.3), `SubmitterProfile` singleton (EIN, BSO, TCC) | Read by 22 payroll/tax files |
| Program employer | `Program.petitionClientId` (H-2B petitioner) | The one place the schema says "who sponsors" |

There is no row that says "this person is employed by X from A to B".

### 7.2 Proposed placement

```prisma
model EmployerOrganization {   // the legal employer: the tenant itself, a client, or a third-party EOR
  id, tenantId, kind EmployerKind (TENANT | CLIENT | THIRD_PARTY)
  legalName, ein, addressLine1/2, city, state, zip, sutaRateOverride, sutaWageBaseOverride
  clientId String? @unique      // when kind = CLIENT, the Client whose facts moved here
  isDefault Boolean             // the tenant's own row
}

model Employment {             // one spell per hire
  id, tenantId, associateId, employerOrgId (→ EmployerOrganization), employmentType,
  hireDate, endDate?, applicationId? @unique, orgUnitId?, siteId?
  @@index([associateId, endDate])
}
```

- **The field the brief names** is `Employment.employerOrgId`: "the tenant" = the tenant's default `EmployerOrganization`; "a separate organization" = any other row.
- Backfill: one `Employment` per APPROVED Application with `hireDate = Associate.hireDate ?? approvedAt`, `endDate = Associate.separatedAt`; one `EmployerOrganization(kind: CLIENT)` per Client that has `legalName` or `ein`, else the tenant default. `Client.legalName/ein/…` stay as read-through columns until the 22 readers switch to `Employment.employer` (the 2-1 report's decision 3, now concrete).
- Payroll reads: `paystubData.ts:202`, `payrollTax91.ts:1226/1407/1504`, `efw2.ts`, `w2Pdf.ts` resolve the employer from the associate's open Employment, grouped per employer for the W-2 run (a staffing tenant with two EORs files two sets, which is correct and is not what happens today).
- `activeDefinition.ts` `Placement` keeps its meaning (where they work); employment answers who pays them. The two differ for a WORKFORCE_PROVIDER and coincide for a DIRECT_EMPLOYER.

## 8. Migration plan

Every step is additive; each one is reversible by redeploying the previous build, since no column is dropped and no constraint is tightened until the last step.

### 8.1 Alto HR → WORKFORCE_PROVIDER

1. Migration: `TenantProfile` (or columns on `Tenant`): `businessModel = WORKFORCE_PROVIDER`, `modules` = all twelve on, `terminology` = `{ worker: associate, site: store, manager: supervisor, client: client, labels: {} }` (empty label overrides = today's strings). One row, fixed tenant id `00000000-0000-4000-8000-000000000001`.
2. Deploy: the profile is served on the session (`/auth/me` and the branding endpoint), `visibleModules` receives it, `requireModule` is mounted, Hugo reads it. With everything on and no overrides the behavior is byte-identical; the proof is the existing web unit tests for `modules.ts`, the e2e suite and the reconciliation report.
3. Nothing else changes for Alto HR in later steps: `clientId` becomes nullable on 15 models but every Alto row keeps its value; the `[tenantId, clientId, …]` unique forms are satisfied by existing rows; `EmployerOrganization` rows are generated from existing Clients; `OrgUnit(REGION)` rows mirror the Regions. The acceptance line is unchanged routes and unchanged reconciliation.

### 8.2 The hotel → DIRECT_EMPLOYER

1. Profile row: `businessModel = DIRECT_EMPLOYER`, modules `scheduling, time, hr_cases, compliance, payroll_sync(QuickBooks only), programs(off), bill_rates(off), client_portal(off), housing(off), transportation(off), robotics(off), agent_builder(off)`, terminology `{ worker: team member, site: property, manager: property manager }` with ES equivalents.
2. **Sites without a Client:** `Location.clientId` nullable (+ `type SiteType`), created by a new `POST /org/sites` (today only `routes/clients.ts:253/434` create one). `Application.clientId`, `Shift.clientId`, `ShiftTeam`, `SchedulingRosterOrder`, `ClockInRequest`, `KioskDevice`, `KioskPin`, `ShiftPosition`, `ShiftRateDefault`, `Department`, `CostCenter`, `Position`, `JobProfile`, `Offer` nullable; every creation path that copies `location.clientId` tolerates null (`routes/scheduling.ts`, `onboarding.ts`, `kiosk99.ts`, `activeDefinition.ts:53-68`).
3. **Scheduling and time with no client:** `scopeShifts`/`scopeTimeEntries`/`scopeAssociates` for `SHIFT_SUPERVISOR`/`FLOOR_SUPERVISOR` switch from `clientId ?? NO_CLIENT` to `orgUnit or location scope`, failing closed when the user has neither (`NO_CLIENT` becomes `NO_SCOPE`). `atStore` (:201) already answers "this site's people" without a client; `atClient` keeps serving staffing tenants. Kiosk already accepts `locationId`.
4. **Payroll export with no client:** `PayrollSchedule.clientId = null` is already company-wide; `Employment.employerOrgId` → the hotel's default `EmployerOrganization` supplies the W-2 block; the ride deduction resolver sees no `RideConsent`/`Ride` rows and the module check skips it; the QuickBooks connection moves its `clientId @unique` to `tenantId`-or-`clientId`.
5. **HR case:** `HrCase` (7642) carries no `clientId` — nothing to do beyond vocabulary.
6. **Onboarding:** `OnboardingTemplate.clientId = null` is already the global track; the `Application.clientId = null` application is onboarded at a `locationId`; the ready-to-work handoff (client portal module) is skipped by the module check.
7. Seed: `prisma/seed.ts` gains a second tenant block, and the e2e acceptance (`e2e/`) runs the five journeys as the hotel's admin, supervisor and team member and asserts no string from the forbidden list (`client`, `bill rate`, `housing`, `van`, `ride`, `store`, `associate`, `Fieldglass`, `Walmart`) in any rendered page or Hugo reply. The same list as a vitest over the API responses of the enumerated routes.

Order within a release: profile → vocabulary plumbing → nullable FKs → scope rewrite → employer → OrgUnit → hotel seed. Reverse order to back out.

## 9. Risks and open decisions

Risks:

- **Vocabulary sweep size.** About 4,600 string literals, 2,202 live dictionary keys, Spanish parity, and no Turkish in the web. The sweep must be test-driven (the forbidden-word e2e) rather than exhaustive: hide first (modules off remove 917 ride strings and the whole portal), then translate the top-30 labels, then chase what the test finds.
- **Scope rewrite is security code.** `lib/scope.ts` is the fail-closed wall for three roles; replacing `clientId ?? NO_CLIENT` with org-unit scope must keep the "fail closed" property and the existing cross-client tests (about 20) plus the generated cross-tenant suite must stay green. Tenancy is still in observe mode; module gating adds a second advisory wall until `TENANCY_MODE=enforce`.
- **Nullable unique constraints** silently allow duplicate rate cards, roster orders and templates (§2.1) unless the partial null indexes land in the same migration.
- **Region duplication.** Two sources of truth for a release while `Region` and `OrgUnit(REGION)` coexist; the command center must read one.
- **Meta templates.** Per-tenant vocabulary in WhatsApp means per-tenant template registration (the text is the template); `whatsappContent.ts` assumes one set.
- **Crons** run once for the org today; the per-tenant loop from 2-1 §9.4 is a prerequisite for "cron skips an off module" to mean anything.
- **The ride deduction** must stay (1A-3 mandate) and be inert, never removed.

Decisions for the owner:

**Decided 2026-10-13 — items 1 to 9 approved as recommended**, with the owner's guardrails: the scope rules must fail closed on tenant and site when client is null, never open, and that test is written first (item 2); the W-2/1099 employer comes from the employment record, never from a Client row (item 3). Items 10 to 12 and the seven risks above were sent to the owner together. Two additions to the plan: the WhatsApp templates take the tenant display name and the assistant name as variables, and the Meta re-registration starts early because it takes days; the hotel seed's forbidden-word test is the acceptance line for 2-1b (no "client", "bill rate", "housing", "van", "store", "associate" when the tenant says "team member", or "Alto" in any screen or Hugo message), with the list kept in the test, not in prose.


1. **Rename `Location` to `Site` physically, or add `Location.type` and let the terminology table say "site"?** Twenty-two models, 199 web files and every URL (`/clients/:id/locations`) reference Location. Recommendation: add `type` and `@@map` later; the noun is the profile's job.
2. **A direct employer with no Client rows (nullable FKs, scope rewrite) or a hidden "self" Client per tenant?** The self-client passes the UI acceptance in a week and leaves the data model staffing-shaped, which the brief's "Client is optional" forbids. Recommendation: nullable FKs on the 15 hotel-path models; the other 17 stay required because their modules are off for a direct employer.
3. **Employer of record as a new `EmployerOrganization` + `Employment` pair (recommended) or as columns on `Application`?** Application dies on cross-client transfer and names a client, not an employer.
4. **OrgUnit absorbs Region now or after the command center is re-pointed?** Recommendation: create the mirror rows now, re-point `routes/region.ts` in the same step, drop Region in a later brief.
5. **Department and CostCenter: fold into OrgUnit or keep per client?** Recommendation: CostCenter folds (it is a ledger unit), Department stays (it is an audience and reporting tree used by broadcasts and pulse surveys).
6. **"payroll sync" = the integrations (Fieldglass, QuickBooks, Synchros, external payments) only, with payroll always on?** The brief's list has no "payroll" module.
7. **Terminology storage: Json on the profile (recommended; validated against a key list in `packages/shared`) or a `TenantTerm` table?** Json ships the whole table on the session in one read.
8. **Module flags: reuse `Tenant.features` (exists, unused) with a validated shape, or a `TenantModule` table?** Recommendation: reuse, validated by a shared zod schema.
9. **Housing link: what does "on" mean?** Nothing exists beyond season-planner beds and the housing agreement kind. Recommendation: the flag hides the bed columns and the agreement kind; a Helios link is its own brief.
10. **Agent builder and robotics flags:** robotics = the ROBOT worker type and its admin page; "agent builder" has no code behind it. Recommendation: the flag hides the Agents module's create affordance and the ROBOT type; nothing more.
11. **MANAGED_PROGRAM and HYBRID semantics.** Nothing in the code would differ from WORKFORCE_PROVIDER unless the business model drives default modules and vocabulary only. Recommendation: `businessModel` sets defaults at tenant creation and is otherwise informational; the code reads `modules` and `terminology`.
12. **Roles per business model:** `TRANSPORTATION_DIRECTOR`, `DRIVER`, `CLIENT_PORTAL` are meaningless to the hotel; hide by module now, and let Brief 2-3 make roles tenant-defined.

## 10. Sizing

| Step | Contents | Weight |
|---|---|---|
| 1. Profile, modules, terminology | `TenantProfile` (or Tenant columns), shared zod contracts (module keys, term keys, defaults per business model), `/auth/me` and branding payload, `requireModule` middleware on ~20 mounts, `visibleModules(modules)`, Hugo intent filter, cron check, Alto HR row, module-off route suite generated from the router | Medium; the one step everything else reads |
| 2. Vocabulary plumbing | `useTerm()` hook over the profile; top-30 labels re-keyed (modules.ts labels, roles.ts labels, portal/region/wf/opsRun keys, WA `store` param, notify subjects); forbidden-word test harness | Medium |
| 3. Optional Client on the hotel path | 15 models nullable, 5 unique constraints rewritten with partial indexes, `POST /org/sites`, `scope.ts` org-unit/site scope with fail-closed `NO_SCOPE`, `activeDefinition` Placement, kiosk, scheduling/onboarding creation paths | Large; the risky one |
| 4. Employer of record | `EmployerOrganization`, `Employment`, backfill from Applications and Clients, 22 payroll/tax readers re-pointed, per-employer W-2 grouping | Medium |
| 5. OrgUnit | model, `Location/Associate/Position/User.orgUnitId`, CostCenter fold, Region mirror and command-center re-point, permission scope at any level | Medium |
| 6. Hotel tenant | seed block, e2e acceptance (onboarding, scheduling, time approval, HR case, payroll export) with the forbidden-word assertion, reconciliation report on both tenants | Small–medium |
| 7. Site type and rename | `Location.type SiteType`, `@@map("Site")`, URL aliases | Small; cosmetic, last |

The vocabulary sweep beyond the top 30 (the ~4,600 literals) is not a step; it is a backlog the forbidden-word test drains, mostly by hiding modules rather than by rewriting strings.
