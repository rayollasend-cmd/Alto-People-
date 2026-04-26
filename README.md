# Alto People

Workforce-management HR platform for **Alto Etho LLC d/b/a Alto HR**.

> **Status:** Phase 1 — foundation & UI shell. Real auth, database, and module logic land in later phases (see roadmap).

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- npm 11+

## Install

From the repo root:

```sh
npm install
```

## Development

Runs the web app and API in parallel:

```sh
npm run dev
```

| Service | URL                    | Notes                         |
| ------- | ---------------------- | ----------------------------- |
| Web     | http://localhost:5173  | Vite dev server               |
| API     | http://localhost:3001  | Express, `/health` endpoint   |

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
- [ ] **Phase 2** — backend, PostgreSQL schema, Prisma
- [ ] **Phase 3** — real JWT auth + RBAC
- [ ] **Phase 4** — Onboarding module end-to-end
- [ ] **Phase 5** — tests for phases 1–4
- [ ] **Phase 6+** — remaining modules + integrations (ASN Nexus, Fieldglass, Wise, Branch, Twilio, FCM, Google Maps)

## Project layout

```
.
├── apps/
│   ├── web/             # React + Vite + Tailwind UI
│   └── api/             # Node + Express API
├── package.json         # workspaces root
├── tsconfig.base.json
└── .editorconfig
```

## Notes for Windows

- If HMR misses changes, make sure the repo is **not** inside a OneDrive-synced folder — file watching can be flaky there.
- `.gitattributes` enforces LF line endings; `.editorconfig` keeps editors aligned.

## License

Proprietary — Alto Etho LLC. All rights reserved.
