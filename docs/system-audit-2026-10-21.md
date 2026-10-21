# System audit, 2026-10-21: what we think we built, against what the code holds

The owner asked for one reconciliation of the whole product: builds we think were done but weren't, builds started and left half way, and work never committed. This document is the synthesis. The nine detailed reports it draws on, each with file and line evidence, are in `docs/audit-2026-10-21/`.

## How it was done

Four sources of intent were checked against the working tree as it stood today (including the batch committed with this document):

1. **The owner's own requests** across all six sessions on this machine (Sep 18 to Oct 21), 466 messages.
2. **The builders' own admissions**: 66 sub-agent final reports that said "not done", "partly", "deferred", "stub" or "left for later". Every admitted gap was re-checked (`admissions-1.md`, `admissions-2.md`).
3. **The end-of-turn summaries** that claimed what was built, 216 concrete claims re-verified in code (`claims-early.md`, `claims-latest.md`).
4. **The twenty investigation documents** in `docs/`, every rollout step and acceptance line checked (`docs-a-d.md`, `docs-f-p.md`, `docs-r-u.md`).

Plus two scans of the code itself for half-finished signatures: markers, dead buttons, routes with no screen, screens with no route, models no code reads, crons never armed, stubbed providers, skipped tests, lint debt (`code-web.md`, `code-api.md`).

Git was checked too: no stashes, main equals origin, and all 25 stale remote branches are patch-equivalent to commits already on main. Nothing is lost in a branch.

## The headline

Most of what was claimed is real. Of 216 completion claims, 208 verified in code, including the hard rules: the pre-payroll review sign-off gates disbursement, a taken ride is never waived, own-account ACH gates disbursement on funding, QuickBooks sync has its outbox and closed-month rule, SOP gates clock-out at the kiosk. The September recruiting, transport, Store Ops and app-shell work holds up almost entirely.

The unfinished work is of four kinds, and the first kind is the one that matters:

- **Silent failures.** Things the product reports as done that never happen: SMS messages, background checks, four nightly jobs, tax obligations on one payroll path. Nobody sees an error.
- **The role walk's remaining four groups.** About 75 of the 117 items from the Oct 20 walk were never started. They are listed in `docs/role-walk-2026-10-20.md`.
- **One-sided features.** Server routes with no screen, or screens whose server side ignores part of the input.
- **Platform hardening that stopped at the runtime guard.** Tenancy, SOC 2 controls, the labor-rules engine.

## 1. Not committed or not pushed (resolved today)

- A 229-file batch from the Oct 21 session (repeating 1:1s, broadcast templates and attestation snoozes, kiosk punch summary, ops activity feed, one definition of an open shift, guarded shift picks and time-off decisions, clean-time approval from payroll, bank deposit matching, notification routing cleanup, saved views on People and Applications) was sitting uncommitted when the session died. It is committed with this document after a full green run.
- No stashes. No unmerged branch content. Main is at origin.

## 2. Thought done, not done, ranked by what it costs

These are the items where the product, a summary, or a plan says it is handled and the code shows it is not.

### Tier 1: money, legal, safety

1. **SMS is a stub everywhere.** `lib/notifications.ts:243` returns `STUB-SMS` for every send. Emergency alerts, call-out texts, shift reminders and every SMS-channel broadcast are recorded as sent and never leave the building. The only Twilio code is inbound voice. Needs an outbound adapter in `dispatch()`.
2. **Own-account payroll settled by "Mark uploaded" leaves no obligations.** `lib/banking/directDeposit.ts:303-350` settles the run and emails paystubs but never accrues the tax deposit, posts liabilities, or creates garnishment remittances. The disburse route only does those when every item already succeeded, which is never true in OWN_ACCOUNT mode. A run paid this way owes taxes the system does not know about.
3. **Self-serve background checks auto-pass.** `routes/onboarding.ts:2755-2805` writes `provider: 'stub', status: 'PASSED'` from a typed name. The Checkr adapter exists and is never consulted on this path. Everyone clears.
4. **Four jobs default to off and are set nowhere.** `SHIFT_REMINDER`, `SCHEDULE_DIGEST`, `WEEK_AHEAD` and `KIOSK_MAINTENANCE` interval seconds default to 0 in `config/env.ts` and are absent from every env file. Shift reminders, both digests, forgotten-clock-out closing and selfie retention never run.
5. **Paydays pass with no run and nobody is told.** No period ledger, no `LATE_APPROVED_TIME` exception. In dev, two paydays and 40.6 approved hours sit unpaid with the home saying "all approved". Finance walk item 1.
6. **The timesheet count opens an empty queue.** Three roles hit it. The count has no date window; the queue opens on the current period; the six pending entries are in a paid period. Walk items floor 1, ops 1, HR 1.
7. **A brief server error signs everyone out.** `lib/auth.tsx:208-232` treats any 5xx on `/auth/me` as a logout. A deploy blip logs out every tablet. Walk items floor 2, ops 3, HR 24.
8. **Dispatch double-books a van and driver, and a driver with no licence passes.** `routes/transport.ts:2451` checks only out-of-service and driver fit; `lib/transportDrivers.ts:286-295` skips a missing profile. Transport walk 1 and 2.
9. **Schedule-change pay is owed but never captured.** The API parses `changeReason` on four scheduling writes; no form in the web sends it. Every change in a predictability-pay city goes unrecorded.
10. **Payroll dollars are not hidden from site-limited users.** Only two inbox sources and the executive route refuse; run and item responses in `routes/payroll.ts` carry full amounts to site-bound callers.
11. **The labor-rules engine runs for pay only.** `payrollSheet`, `clientStatement`, `associateEarnings`, finance and executive views, shift reminders and scheduling have zero references to `lib/laborRules`; `evaluateSchedule` has no caller, so minors and rest rules never block a schedule. The sheet and the paycheck still disagree on daily overtime.
12. **Tenancy stopped at the runtime guard.** 481 nullable `tenantId` columns, none required; no row-level security, no `alto_app` role; blob keys, rate limits and Sentry are not tenant-scoped; ten routes are accepted leaks in `crossTenant.baseline.json`. The enforcing migration and RLS deploy from the multi-tenancy plan never landed.
13. **SOC 2 controls with holes.** Selfie and face-template columns are plain (not in the keyring field list); backups never prune to the 35-daily, 12-monthly rule; no scheduled dependency scan, no Dependabot or CodeQL; key rotation batches are not transactional; bad `FIELD_KEY_ACTIVE` lets the app boot and fail at first read.
14. **Hiring compliance that does not exist.** Applicant EEO self-identification, the FCRA adverse-action flow, and I-9 retention and reverification. Nothing in api or shared.
15. **Erasure misses the login-tracking tables.** `lib/erasure.ts` never touches `UserActivityDay` or `UserKnownIp`; a person's activity and IP history survive an erasure request.
16. **The Internal Recruiter holds the full admin capability set.** `roles.ts:439` is `FULL_ADMIN`; the menu was curated but SSN reveal, roles and API keys are reachable by URL.
17. **Statement money that is wrong by construction.** Invoice sales tax is always $0.00 (`statementPdf.ts:247`); there is no stored remit-to address; group-term life over $50k has a W-2 label but no imputed-income calculation.
18. **The cash forecast starts at zero, ignores bills, and skips a payday with no people on schedule.** `lib/cashForecast.ts:142` `if (net <= 0) continue`. Books now holds the real balance and the bills.
19. **Tax data pinned to "confirm with vendor".** 82 markers in `deductionTaxability` (17), embedded payroll (10), the external tax engine (9), e-IWO (8), ACH origination (8), state withholding (8), contractors (6). Nineteen state withholding tables are unverified (the acknowledgement gate blocks payroll until an admin signs, so the gate works and the data is the gap). The IRS FIRE 1099 file has never been validated; EFW2 refuses 2026 W-2s that carry tip and overtime codes.
20. **Audit chain is verified only on demand.** `runAuditChainChecks` is never called; the nightly verifier the identity plan promised does not run.

### Tier 2: the role walk's four unstarted groups

Roughly 75 items. See `docs/role-walk-2026-10-20.md` for each with its spec. In short:

- **Payroll, finance and books** (finance walk 1–20): period ledger and off-cycle CTA, cash forecast, one aging definition, readiness bulk request, five-group Pay menu, statement week close with Record Payment, collections worklist, pay many vendors, changes vs last run before create, honest payroll home, "billed not paid", disburse dialog with provider status, pay change context and mass pay change, close steps inline, executive money band, create-the-deposit, in-house Pay tab, mobile card labels.
- **Time, approvals and scheduling** (ops walk 1–12, 14, 15, 19–21, 24; floor 1, 7–9, 11, 25; HR 1, 16, 19): the queue link and oldest pending period, one time zone per shift, sticky toolbar and grid above the fold, Topbar at 1024, past shifts as unfilled with close-out, Assign dialog facts, alt-drag copy and drag fit, day-view lanes, publish review sheet, manager open-shifts tab, coverage heat strip, phone scheduling and queue sheets, new-shift prefill, time opens on the queue, Inbox folds zeros, manager nav fold, availability presets, own-entry approval guard.
- **Transport director and driver** (transport walk 1–13; floor 5, 16–19): van and driver overlap check, licence required, top up existing runs, stuck-run sweep, map in Dispatch and Plan, van timeline, rider record, ask-to-sign, driver fuel log, batch dispatch, mobile header, keyboard, charges range in URL, offline driver taps, van-can't-run from Report a problem, GPS on arrived and no-show, "I'm here" text, driver Hugo audience.
- **HR, recruiting and cross-cutting** (HR walk 2–15, 17, 18, 20–24; floor 10, 20, 23, 24, 26; ops 2, 5, 20, 22): HR home on legal deadlines, E-Verify link filtered, Inbox by urgency, staffing gap to posting, People multi-select, offer in one step, interviewer picker, candidate next/previous, first-day card, separation in header with the right deadline, HR opens a case, HR phone tabs, sticky phone action bars, report templates, posting and candidate click savers, audit labels, deadline strip, pay schedule at application, Spanish gaps, Today roster names, bell on touch, associate Needs-you as tasks, profile polish.

### Tier 3: one side built, the other not

Server routes with no screen, or screens whose server side ignores part of the input. Each is a few hours to finish or a decision to delete.

- Federal W-4 facts (`/payroll/federal-w4`: exempt, NRA, pre-2020, IRS lock-in) mounted, eight columns migrated, zero web callers.
- Local tax rules: routes exist, no page lets payroll set a city or county rule.
- Skills claim and verify, worktag assignment and report, VTO policy editor, roster order, decline-my-shift, region update and delete, transport van list and driver shifts: routes exist, no control.
- Broadcast channels are stored and ignored; send-now fans out bell and email regardless.
- The supervisor's coverage-gap notice is client-side only; the bell and phone badge still say all clear.
- The open-shift count in Needs-you builds its own predicate instead of the shared `isOpenShift`.
- Expense reports answer 501 while the Reimbursement model and router exist; the report builder still offers "Expense".
- Equity EXPIRED has no job. No new-hire filing provider is registered (CSV for manual upload only).
- Robots: checklist templates API-only, incident severity hard-coded to first aid, retention date computed and never read, polygon zones draw rectangles, push channel declared with no implementer.
- Tasks engine: robot candidates not filtered to the site; per-site policy replaces instead of merges.
- Billing: no stored Stripe customer fields; billing page has no contact or payment method; decision notices are stamped but never sent.
- Bulk candidate removal is single-id only. The "who covers your SOP" prompt on a supervisor's approved time off was never hooked in.
- Trust Center: no gated downloads, no SOC 2 progress; roles and permissions live inside Users; roster not unified across people and agents; three product-analytics events never added.
- Two QuickBooks integrations are mounted; the Phase-44 one has dead tokens since the June key rotation.
- Tenant profiles: nine mounts are not module-gated (client portal, finance overview, client requests, messages, ready-to-work, workers, agents, agent v1, emergency), so a hotel tenant still gets 200 on portal and statement routes; Fieldglass columns and the paystub ride row are ungated; no hotel tenant in the seed.

### Tier 4: hygiene

- The client-facing compliance scorecard permanently shows five "Coming soon" signals (`complianceScorecard.ts:1049-1053`).
- Dead code: `ModulePlaceholder.tsx`, `StubTask.tsx` and its eight keys, `lib/decisionsApi.ts`, `lib/useFieldglassSetupCount.ts`, 66 API-client functions nothing calls, two client functions that target routes that do not exist, 27 shared constants nothing imports, 51 response schemas the API never validates against.
- Tests: the hotel-tenant forbidden-words sweep still skips Celebrations, Assets, Ramp and Expirations from a round that is over; eleven Playwright suites never run without env flags; the cross-tenant suite passes only through a ten-route baseline.
- Lint debt, all within baseline: 105 real hard-coded strings (Settings 20, Learning 33, KB 15, Marketplace 14), 143 raw headings (client portal 22, auth pages 19), 33 hex colors (15 in the live map), 19 ad-hoc empty states, 70 light-mode override rules, 55 oversize radii.
- Config: about 100 of 163 env keys are missing from `.env.example`, including every provider key and `TENANCY_MODE`; `FLEET_*`, `MICR_FONT_PATH` and four rate-limit knobs are read outside `config/env.ts`.
- About 25 one-off scripts have no run record. `backfill-deduction-lines.ts` matters: `paystubData.ts:337` assumes it ran.
- Stale comments: `routes/auth.ts` says MFA is not enforced (it is); `App.tsx:39` mentions ~50 placeholder routes (there are none); `efw2c.ts` cites a TODO that no longer exists.

## 3. Holds and owner inputs, not gaps

- Labor hours against budget on the shift supervisor hero (held Oct 17). The client portal as it is (held Oct 17). Housing rent deduction (held Sep 26, design saved). Seniority bidding and fatigue guardrails (held).
- Vendor credentials and live modes: Twilio outbound, Checkr, TaxBandits, Symmetry or Vertex, Check HQ or Zeal, Intuit live keys, Stripe prices and live approval, DHS E-Verify ICA, eScreen or Quest, ASN Nexus, fleet APIs, Mapbox token in production. Code is written against public docs; the "confirm with vendor" markers are where a contract or sandbox is needed.
- Production-only acceptance runs (Okta and Entra real orgs, restore test, production key rotation, two agents live for a week with scorecards).

## 4. Recommended order

**Wave A, silent failures (days, not weeks).** Items 1 to 10, 15 and 16 of Tier 1: outbound SMS, own-account accruals, background check to "not run", the four crons armed by default, the period ledger and off-cycle CTA, the timesheet queue link, 5xx keeps the session, dispatch overlap and licence, `changeReason` in the web forms, payroll amounts stripped for site-bound callers, erasure tables, a recruiter capability set. Each is small and each is currently lying to a user.

**Wave B, the role walk remainder.** The four groups in Tier 2, as four builders owning disjoint files, the way the Oct 21 session ran the first three.

**Wave C, platform hardening.** Tenancy migration C and the RLS deploy; the SOC 2 holes; one labor-rules engine for every caller with `evaluateSchedule` wired to publish; the hiring-compliance trio; the audit-chain nightly.

**Wave D, one-sided features and hygiene.** Tier 3 as finish-or-delete decisions; the scorecard placeholders; the dead code; the forbidden-words skips; `.env.example`; stale comments.

## Appendix: the detailed reports

| File | Covers |
|---|---|
| `audit-2026-10-21/admissions-1.md` | Builders' admitted gaps, Sep 18 to Oct 18 sessions |
| `audit-2026-10-21/admissions-2.md` | Builders' admitted gaps, Oct 18 to 21, including the walk |
| `audit-2026-10-21/claims-early.md` | 104 completion claims from September, verified |
| `audit-2026-10-21/claims-latest.md` | 112 completion claims from Oct 17 to 21, verified |
| `audit-2026-10-21/docs-a-d.md` | access-cleanup, ach-own-account, agent families, agent billing, ASN, control room, design system |
| `audit-2026-10-21/docs-f-p.md` | forecasting, identity and RBAC, integrations, labor rules, multi-tenancy, taxonomy, public API |
| `audit-2026-10-21/docs-r-u.md` | robots, scale, SOC 2, tasks, tenant profiles, UX upgrade, runbooks |
| `audit-2026-10-21/code-web.md` | Web markers, skipped tests, orphans, i18n and design debt, env flags, endpoint coverage |
| `audit-2026-10-21/code-api.md` | API stubs, mounts, Prisma, crons, shared contracts, scripts, integrations |
| `role-walk-2026-10-20.md` | The 117 role-walk items with specs and build status |
