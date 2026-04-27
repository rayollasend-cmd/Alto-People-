# Alto People

Workforce-management HR platform for **Alto Etho LLC d/b/a Alto HR**.

> **Status:** Phase 38 — Analytics & Reporting page. New `/analytics` view surfaces the existing `/analytics/dashboard` KPIs in dense, themed sections (Workforce, Scheduling, Payroll, Onboarding & compliance) plus a one-click CSV export of the raw numbers. Same data the admin home tiles use, presented for reporting. Caps a 5-phase HR-tools batch (Phases 34-38) that also added Client Management UI, bulk paystub ZIP downloads, an HR e-sign agreement composer, and per-client jobs management.

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- npm 11+
- Docker Desktop (for the local Postgres dev container)

## Install

From the repo root:

```sh
cp .env.example .env                  # postgres user/password
cp apps/api/.env.example apps/api/.env  # api env incl. DATABASE_URL
npm install
```

## Database (Postgres 16 via Docker Compose)

Start the local Postgres container:

```sh
npm run db:up        # docker compose up -d postgres
npm run db:migrate   # apply Prisma migrations (first run creates them)
npm run db:seed      # populate one client, associate, application, template
```

Useful follow-ups:

```sh
npm run db:studio    # open Prisma Studio in the browser
npm run db:logs      # tail the Postgres container logs
npm run db:down      # stop the container (volume persists)
```

The volume `alto-people-pg-data` survives `db:down`/`db:up`. To wipe schema + data:

```sh
npm -w apps/api run db:reset
```

## Development

Runs the web app and API in parallel:

```sh
npm run dev
```

| Service  | URL                    | Notes                                          |
| -------- | ---------------------- | ---------------------------------------------- |
| Web      | http://localhost:5173  | Vite dev server                                |
| API      | http://localhost:3001  | Express. Routes: `/health`, `/clients`, `/onboarding/*` |
| Postgres | localhost:5432         | Docker Compose (`npm run db:up`)               |

The web dev server proxies `/api/*` → `http://localhost:3001/*`.

To run them individually:

```sh
npm run dev:web
npm run dev:api
```

## Login

Sign in at `/login` with email + password. Auth is JWT-in-httpOnly-cookie (24h, SameSite=Lax). Sessions survive refresh and are invalidated server-side via `User.tokenVersion`. Login uses argon2id; failed attempts are rate-limited (20/min/IP, 5/15min/email) and recorded in `AuditLog`.

**Dev seed credentials** (all should be rotated before any non-local use; the seed only sets the password when `passwordHash` is null, so existing hashes are left alone):

| Email                              | Password           | Role            |
| ---------------------------------- | ------------------ | --------------- |
| `admin@altohr.com`                 | `alto-admin-dev`   | HR_ADMINISTRATOR |
| `maria.lopez@example.com`          | `maria-dev-2026!`  | ASSOCIATE       |
| `portal@coastalresort.example`     | `portal-dev-2026!` | CLIENT_PORTAL   |

`apps/api/.env` must include:
- `JWT_SECRET` ≥ 32 chars (generate via `openssl rand -base64 48`)
- `PAYOUT_ENCRYPTION_KEY` = 32-byte base64 (generate via `openssl rand -base64 32`) — used for at-rest encryption of W-4 SSN and bank account numbers

## Creating an onboarding application (no UI yet)

Phase 4 ships endpoints; the HR-create form is Phase 5+. Create from a logged-in admin shell:

```sh
JAR=$(mktemp).cookies
curl -sS -c "$JAR" -X POST http://localhost:3001/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@altohr.com","password":"alto-admin-dev"}'
# get clientId + templateId from /clients and /onboarding/templates, then:
curl -sS -b "$JAR" -X POST http://localhost:3001/onboarding/applications \
  -H 'Content-Type: application/json' \
  -d '{
    "associateEmail":"new.hire@example.com",
    "associateFirstName":"Demo",
    "associateLastName":"Hire",
    "clientId":"<uuid>",
    "templateId":"<uuid>",
    "position":"Server"
  }'
```

## Roles

| Role                  | Access                                                |
| --------------------- | ----------------------------------------------------- |
| Executive / Chairman  | Read-only across all modules and clients              |
| HR Administrator      | Full access to every module                           |
| Operations Manager    | Full operational access; cannot process payroll      |
| Live ASN              | System integration only — not selectable for humans  |
| Associate             | Personal access (own profile, schedule, pay)          |
| Client Portal         | Read-only, scoped to one client account               |
| Finance / Accountant  | Read-only access to financial modules                 |
| Internal Recruiter    | Full access to recruiting pipeline                    |

## Tests

Vitest is wired up in all three workspaces.

```sh
npm test            # all suites: shared → api → web
npm run test:shared # shared: roles + Zod contracts (pure unit)
npm run test:api    # api: lib unit tests + route integration tests
npm run test:web    # web: Login + four onboarding task forms (jsdom + RTL)
```

The **API integration tests** run against your real Postgres but on a separate
`alto_test` schema, so the `public` schema (your dev data) is never touched.
The schema is created on first run, migrations are applied via
`prisma migrate deploy`, and every test truncates `alto_test.*` before
running. To opt in:

```sh
cp apps/api/.env.test.example apps/api/.env.test
# edit DATABASE_URL / DIRECT_URL to add `&schema=alto_test` and point at your DB
npm run test:api
```

The integration tests cover: every `/auth/login` failure path, the per-email
rate limiter, stale-cookie handling, RBAC denial on `/clients`, the full
onboarding happy path (PROFILE_INFO → W4 → DIRECT_DEPOSIT → POLICY_ACK),
encryption-at-rest verification of W-4 SSN and bank account numbers,
PROFILE_INFO idempotency, cross-tenant isolation, HR-only task skip, audit
timeline ordering, and template scoping.

## Roadmap

- [x] **Phase 1** — foundation & UI shell
- [x] **Phase 2** — backend, PostgreSQL schema, Prisma
- [x] **Phase 3** — real JWT auth + RBAC
- [x] **Phase 4** — Onboarding e2e (PROFILE_INFO, W4, DIRECT_DEPOSIT, POLICY_ACK fully implemented; DOCUMENT_UPLOAD, E_SIGN, BACKGROUND_CHECK, I9_VERIFICATION, J1_DOCS stubbed with HR-only "skip" affordance)
- [x] **Phase 5** — tests for phases 1–4 (Vitest across `packages/shared`, `apps/api`, `apps/web`; integration suite against `alto_test` schema)
- [x] **Phase 6** — Time & Attendance: associate clock-in/out, HR approval queue with reject reasons, partial unique index preventing concurrent double clock-in, full audit trail
- [x] **Phase 7** — Scheduling: shift CRUD with status (DRAFT/OPEN/ASSIGNED/COMPLETED/CANCELLED), assign/unassign/cancel with reasons, ASSOCIATE-scoped `/me/shifts`, audit trail
- [x] **Phase 8** — Payroll MVP: PayrollRun + PayrollItem with snapshotted hours/rate/gross/tax/net; aggregates APPROVED TimeEntries × hourly rate (from period Shifts, falls back to default); placeholder federal withholding by W-4 filing status; DRAFT → FINALIZED → DISBURSED lifecycle; **disbursement is stubbed** (returns `STUB-…` refs — real Wise/Branch wiring is future work); FINANCE_ACCOUNTANT can view but only HR_ADMINISTRATOR can `process:payroll`
- [x] **Phase 9** — Document vault: multipart upload (PDF/PNG/JPG/WEBP, 10 MB cap), associate `/me` + HR `/admin` verify/reject queue with rejection reasons, content-addressed local-fs storage at `apps/api/uploads/` (gitignored). The `s3Key` column stays — only the resolver in `lib/storage.ts` changes when S3 lands. Soft-delete preserves the audit trail; verified docs cannot be deleted by the associate
- [x] **Phase 10** — Compliance dashboard: I-9 section 1 / section 2 verification (HR is recorded as the verifier; document list required for section 2), background checks (initiate is **stubbed** — real Checkr/Sterling lives here in a future drop-in; HR can manually flip status), J-1 program profiles with DS-2019 + sponsor + days-until-end indicator. Three-tab UI per module
- [x] **Phase 11** — Analytics: `GET /analytics/dashboard` returns live KPIs (active associates, currently clocked-in, open shifts in next 30d, pending onboarding, pending I-9 section 2, pending document reviews, net paid in last 30d, net pending disbursement, application status histogram). Dashboard.tsx replaces "—" placeholders with live numbers
- [x] **Phase 12** — Communications: `Notification` model with channels (SMS / PUSH / EMAIL / IN_APP) and statuses (QUEUED / SENT / FAILED / READ). HR can send to a specific recipient or broadcast to ALL_ASSOCIATES / ALL_HR. **External providers (Twilio / FCM / Resend) are stubbed** — `lib/notifications.ts` returns synthetic refs; swapping in the real client is one file. Associate inbox shows IN_APP with unread badge + click-to-mark-read
- [x] **Phase 13** — Performance reviews: `PerformanceReview` model with DRAFT → SUBMITTED → ACKNOWLEDGED lifecycle. HR composes (overall rating 1–5, summary, strengths/improvements/goals); associates only see SUBMITTED + ACKNOWLEDGED rows (DRAFT stays hidden). Cross-associate access returns 404 not 403 to avoid leaking existence. Added `view:performance` to ASSOCIATE capabilities so they can read their own
- [x] **Phase 14** — Recruiting: `Candidate` model with pipeline stages (APPLIED → SCREENING → INTERVIEW → OFFER → HIRED / WITHDRAWN / REJECTED). HR creates, advances, and converts candidates. `POST /candidates/:id/hire` creates the Associate record and (optionally, with `clientId`+`templateId`) the matching Onboarding `Application` + checklist — closing the recruiting → onboarding handoff loop. REJECTED and WITHDRAWN require a reason; soft-delete preserves the audit trail; HIRED candidates are immutable
- [x] **Phase 15** — Time & Scheduling depth (Rippling-grade): geofenced clock-in via haversine + Decimal(10,7), job costing with separate billRate/payRate, break tracking with auto-close + 30-min meal enforcement, clock-out anomaly detection, real-time active dashboard, schedule conflict detection, weekly availability windows, peer→manager swap marketplace with ranked auto-fill suggestions
- [x] **Phase 16** — Associate invitation flow: `InviteToken` model (raw 32-byte base64url in the magic link, SHA-256 hash in DB; 7-day TTL via `INVITE_TOKEN_TTL_SECONDS`); `POST /onboarding/applications` now creates `INVITED` User + token + queues a welcome EMAIL Notification (real Resend when `RESEND_API_KEY` + `RESEND_FROM` are set; otherwise stubbed to the API console with the link visible). Public `GET /auth/invite/:token` returns the invite summary; `POST /auth/accept-invite` consumes the token, sets the password, flips the user to `ACTIVE`, and issues the session cookie atomically. 404 (not 403) is returned for unknown / expired / consumed / cross-user tokens to avoid an existence oracle. Web `/accept-invite/:token` page closes the loop end-to-end
- [x] **Phase 17** — Invitation lifecycle: 48-hour reminder sweep (`runInviteReminderSweep` in `lib/inviteReminder.ts`, gated by `INVITE_REMINDER_INTERVAL_SECONDS` env — 0 disables, e.g. 1800 in prod). Sweep finds INVITED users with open tokens older than 48h not yet reminded, rotates the token (kills old link, creates fresh one, marks `reminderSentAt` for idempotency), and emails the fresh magic link. HR can also trigger an explicit rotation via `POST /onboarding/applications/:id/resend-invite` (returns 409 if the user already accepted; ignores the 48h gate). Audit-logged as `onboarding.invite_resent`
- [x] **Phase 18** — Multi-jurisdiction payroll tax + paystub PDF: real federal (IRS Pub 15-T 2024 percentage method, three filing statuses, full W-4 step 3/4 inputs honored), Social Security (6.2% to $168,600 wage base), Medicare (1.45% + 0.9% surcharge over $200k YTD), per-state SIT (real CA + NY brackets, the nine no-SIT states return $0, 4% fallback elsewhere), employer-side FICA/Medicare/FUTA/SUTA. `PayrollItem` now carries the full breakdown plus YTD wage snapshots; `PayrollRun.totalEmployerTax` exposes the company's true burdened cost. `GET /payroll/items/:itemId/paystub.pdf` renders a PDF on demand and stamps `PayrollItem.paystubHash` on first download for immutability proof
- [x] **Phase 19** — E-signature with PDF + audit trail: new `EsignAgreement` model attached to an Application and (optionally) an `E_SIGN` checklist task. HR creates the agreement (`POST /onboarding/applications/:id/esign/agreements`); the associate signs by typing their name (`POST .../sign`). The server renders a deterministic PDF (pdfkit) containing the body, the typed signature in script style, and an audit panel with signer/IP/UA/signedAt/sha256, persists it under the document vault (kind `SIGNED_AGREEMENT`), creates a `Signature` row with `typedName` + `pdfHash`, marks the linked task DONE, and `GET /onboarding/esign/signatures/:id/pdf` re-streams the bytes with both stored and live sha256 in the response headers so any drift is detectable
- [x] **Phase 20** — I-9 Section 1 self-attest + mobile camera doc capture: extends `I9Verification` with `citizenshipStatus` (USCIS enum: US_CITIZEN / NON_CITIZEN_NATIONAL / LAWFUL_PERMANENT_RESIDENT / ALIEN_AUTHORIZED_TO_WORK), `alienRegistrationNumberEnc` (encrypted bytes — same crypto as W-4 SSN), `workAuthExpiresAt`, and the typed-name signature audit (typedName + IP + UA). New self-service endpoints under `/onboarding/applications/:id/i9/...`: `section1` (associate attests), `documents` (multipart upload with `documentKind` + optional `documentSide` FRONT/BACK — built for `<input capture="environment">` mobile camera), `section2` (HR verifier picks `documentList` LIST_A or LIST_B_AND_C and verified document IDs; refuses to run before Section 1; rejects supporting docs that don't belong to the associate). Both sections complete → the `I9_VERIFICATION` checklist task auto-completes; the verified documents flip to status VERIFIED with the HR user as verifier
- [x] **Phase 21** — Associate-facing I-9 React UI (`apps/web/src/pages/onboarding/tasks/I9Task.tsx`): three-card layout (Section 1 attestation form / document uploader / Section 2 read-only status). The form conditionally reveals A-Number + work-auth-expiry fields per USCIS status; the upload control uses `<input type="file" accept="image/*,application/pdf" capture="environment">` so phones open the camera directly. New `apps/web/src/lib/i9Api.ts` (FormData-aware fetch helper since the shared `apiFetch` is JSON-only). `AssociateChecklist` now treats `I9_VERIFICATION` as a first-class task
- [x] **Phase 22** — Disbursement adapter + bulk paystub ZIP: new `lib/disbursement.ts` defines `DisbursementAdapter` interface and three implementations (`StubAdapter` default, `WiseAdapter` + `BranchAdapter` scaffolded for one-line real-provider switch when `WISE_API_KEY` / `BRANCH_API_KEY` are set + `PAYROLL_DISBURSEMENT_PROVIDER` env). Each disburse call appends a `PayrollDisbursementAttempt` row regardless of outcome — full retry audit trail. `FAILED` adapter response holds that item (`HELD` + `failureReason`) without failing the run; run only reaches `DISBURSED` when every item succeeded. New `GET /payroll/runs/:runId/paystubs.zip` streams a `archiver`-built ZIP of every paystub PDF for HR/Finance bulk download (also stamps `paystubHash` on first generation)
- [x] **Phase 23** — Per-state labor policy templates: new `lib/stateLaborPolicy.ts` table for 15 states (CA/NY/IL/MA/NJ/PA/WA/CO/AZ/GA/NC/VA/FL/TX/OR) with `minimumWageCents`, `dailyOTHoursThreshold`, `weeklyOTHoursThreshold`, `mealBreakMinMinutes` + `mealBreakRequiredAfterHours`, `restBreakMinMinutes` + `restBreakRequiredPerHours`, `paidSickLeaveAccrualPerHour`, `hasPredictiveSchedulingLaw`, `splitShiftPremiumApplies`. `FEDERAL` is the safe fallback for everywhere else. The clock-out anomaly engine in `lib/timeAnomalies.ts` now reads the associate's state and applies per-state thresholds — daily OT for CA/CO, state-aware meal-break minimums, deduped OT signals when both daily and weekly thresholds trip. Pure unit-tested; existing federal-default tests still pass
- [x] **Phase 24** — HR Section 2 verifier UI in Compliance dashboard: new card on `apps/web/src/pages/compliance/I9Tab.tsx` lets HR pick the documentList (LIST_A vs LIST_B+C), tick the verified document IDs, and submit Section 2 from the same screen they audit pending I-9s — no need to bounce into the associate's onboarding checklist. Refuses to submit before Section 1; surfaces the exact server reason on cross-associate / wrong-list errors
- [x] **Phase 25** — Predictive-scheduling enforcement: shift create/update/cancel now consults `lib/predictiveScheduling.ts`, which reads the associate's `Client.state` and applies the per-state notice window from Phase 23 (`hasPredictiveSchedulingLaw`). Late-add/late-edit/late-cancel inside the window write a `PredictiveSchedulingViolation` row tagged with the rule violated and a `predictivePremiumCents` owed-to-associate amount; Phase 18 payroll picks those up automatically. UI flags violations on `AdminSchedulingView` with a "Why?" tooltip
- [x] **Phase 26** — State-driven sick-leave accrual ledger: every APPROVED `TimeEntry` posts to a `TimeOffLedgerEntry` (per-associate, per-bucket, signed minutes). Accrual rate comes from Phase 23's `paidSickLeaveAccrualPerHour` for the work-site state. New balance reader exposes `accrued / used / balance` minutes per bucket and feeds the associate dashboard sick-time tile. Idempotent per `TimeEntry.id`
- [x] **Phase 27** — UI/UX foundation: Radix primitives (Dialog, DropdownMenu, Tooltip, Select, Toast), `lucide-react` icons, `sonner` toast root, AA-contrast palette tightening, design-token doc, shared `Button`/`Card`/`Badge`/`Input`/`Label`/`Skeleton`/`Table` primitives in `components/ui/*`. Replaces ad-hoc Tailwind chains with a small composable surface
- [x] **Phase 28** — Migrated high-traffic pages (Login, Dashboard, OnboardingHome, ApplicationsList, ApplicationDetail, AssociateChecklist, all four onboarding task forms, AdminTimeView, AssociateTimeView, AdminPayrollView, AssociatePayrollView) to the Phase 27 primitives — consistent borders, focus rings, spacing, and motion
- [x] **Phase 29** — Power-user polish: cmd-K command palette (`cmdk`) with global keyboard shortcut and route fuzzy-search, notifications bell in the topbar wired to `/communications/me/inbox` with unread badge + click-to-mark-read, `framer-motion` AnimatePresence page transitions on route changes
- [x] **Phase 30** — Time-off request + approval workflow: new `TimeOffRequest` model (DRAFT → SUBMITTED → APPROVED/DENIED/CANCELLED), Phase 26 ledger automatically debits `requestedHours` on approve, `Insufficient balance` blocks approve atomically inside a `prisma.$transaction({ timeout: 30_000 })` (Neon cold-start safe). Three-pane UI: associate `AssociateTimeOffView` (balance + request form + my requests), HR `AdminTimeOffView` (queue with approve/deny + denial reasons)
- [x] **Phase 31** — HR create-application + invite UI: replaces the curl-only flow from Phase 4. New `NewApplicationDialog.tsx` on `ApplicationsList` lets HR pick a client + template, type the new associate's name + email + position, and submit; the server creates the User + Application + InviteToken + queues the welcome email all in one call (Phase 16 plumbing). Dev-stub mode shows the inviteUrl with a copy button. `Resend invite` button on `ApplicationDetail` for stuck flows
- [x] **Phase 32** — Post-accept onboarding nudge: `POST /auth/accept-invite` now returns `nextPath` so the AcceptInvite page can route the new hire straight into `/onboarding/me/:applicationId` (their checklist) instead of the generic dashboard. Layout-level `OnboardingBanner` reminds incomplete associates whenever they navigate elsewhere — no more stale 5%-complete applications because the user "forgot to come back"
- [x] **Phase 33** — Associate-centric dashboard: `Dashboard.tsx` slimmed to a role router; new `AssociateDashboard.tsx` (clock-in/out card with shift context, next 3 shifts, latest paystub net, time-off accrued+pending) replaces the old "blank admin tiles for everyone" experience. HR/exec roles still see `AdminDashboard.tsx` (Phase 11 KPI tiles)
- [x] **Phase 34** — Client Management UI: new `/clients` list and `/clients/:id` detail. Detail page exposes the work-site state selector (drives Phase 23 OT/break/predictive policies) and a geofence editor with a "Use my current location" shortcut (`navigator.geolocation` via `tryGetGeolocation`). Reads/writes go through new `clientsApi.ts` wrappers
- [x] **Phase 35** — Bulk paystub ZIP download button: surfaces the Phase 22 `/payroll/runs/:id/paystubs.zip` endpoint as a "Download all paystubs (ZIP)" link on `AdminPayrollView`, visible once the run is FINALIZED or DISBURSED — HR no longer has to construct the URL by hand
- [x] **Phase 36** — HR e-sign composer: Phase 19 shipped the associate-side signing flow but HR had no way to *draft* new agreements from the UI. New `EsignSection.tsx` on the application detail page lists every agreement and opens a composer dialog (title + body + optional checklist-task link). Backed by a new `GET /onboarding/applications/:id/esign/agreements` list endpoint plus the existing create POST
- [x] **Phase 37** — Per-client jobs management: new `JobsSection.tsx` on `ClientDetail` with create/edit/archive over the Phase 15 `Job` model (default `billRate` revenue + `payRate` cost). Mutation gated on `manage:scheduling` since these defaults flow into shift creation. Archived jobs hide from new shifts but stay attached to history
- [x] **Phase 38** — Analytics & Reporting page: dedicated `/analytics` view that surfaces the existing `/analytics/dashboard` KPIs in denser, themed sections (Workforce, Scheduling, Payroll, Onboarding & compliance) plus a CSV export of the raw numbers. Same data the admin dashboard tiles use, presented for reporting

## Project layout

```
.
├── apps/
│   ├── web/                    # React + Vite + Tailwind UI
│   └── api/                    # Node + Express API
│       ├── prisma/
│       │   ├── schema.prisma   # Phase 2 schema
│       │   └── seed.ts
│       └── src/
│           ├── routes/         # /health, /clients, /onboarding
│           ├── middleware/
│           ├── config/env.ts
│           ├── db.ts           # Prisma client singleton
│           └── app.ts
├── packages/
│   └── shared/                 # @alto-people/shared (roles + Zod contracts)
├── docker-compose.yml          # Postgres 16
├── package.json
└── tsconfig.base.json
```

## Notes for Windows

- If HMR misses changes, make sure the repo is **not** inside a OneDrive-synced folder — file watching can be flaky there.
- `.gitattributes` enforces LF line endings; `.editorconfig` keeps editors aligned.

## License

Proprietary — Alto Etho LLC. All rights reserved.
