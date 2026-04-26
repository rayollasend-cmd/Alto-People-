# Alto People

Workforce-management HR platform for **Alto Etho LLC d/b/a Alto HR**.

> **Status:** Phase 20 — I-9 Section 1 self-attestation + mobile camera document capture. The associate fills out Form I-9 Section 1 directly (`POST /onboarding/applications/:id/i9/section1` with citizenship status + typed-name signature; A-Number encrypted at rest like W-4 SSN), takes a photo of their ID through the mobile browser camera (`POST .../i9/documents` multipart), and HR Section 2 verifier records which document IDs satisfied List A or List B+C (`POST .../i9/section2`). When both sections complete, the `I9_VERIFICATION` checklist task auto-DONE-s. USCIS rules are enforced (e.g. `ALIEN_AUTHORIZED_TO_WORK` requires both an A-Number and a work-auth expiry).

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
