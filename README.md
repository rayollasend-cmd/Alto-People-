# Alto People

Workforce-management HR platform for **Alto Etho LLC d/b/a Alto HR**.

> **Status:** Phase 2 — backend & schema in place. Real auth (Phase 3) and Onboarding e2e (Phase 4) follow.

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

## Phase 1 mock login

The login screen presents a role picker. Pick a role to preview the navigation that role sees — the sidebar filters modules by the role's capabilities. The selection is persisted to `localStorage` ("alto.mockRole") and survives refresh. Real authentication arrives in Phase 3.

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

## Roadmap

- [x] **Phase 1** — foundation & UI shell
- [x] **Phase 2** — backend, PostgreSQL schema, Prisma
- [ ] **Phase 3** — real JWT auth + RBAC
- [ ] **Phase 4** — Onboarding module end-to-end
- [ ] **Phase 5** — tests for phases 1–4
- [ ] **Phase 6+** — remaining modules + integrations (ASN Nexus, Fieldglass, Wise, Branch, Twilio, FCM, Google Maps)

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
