# Lighthouse CI

Lighthouse scores for the **production build** of the web app — what ships, not
the dev server (which serves unbundled modules and would score nothing like
production).

| Run | Pages | Signed in as | Emulation |
| --- | --- | --- | --- |
| public | `/login`, `/careers`, `/status`, `/trust-center` | nobody | phone |
| admin | `/`, `/clients`, `/scheduling`, `/payroll`, `/recruiting/analytics`, `/labor-costs`, `/call-outs` | admin@altohr.com | desktop |
| associate | the associate's home (`/?lhci=associate`) | maria.lopez@example.com | phone |

"Phone" is Lighthouse's mobile emulation (Moto G Power, simulated slow 4G, 4x
CPU slowdown); "desktop" is its desktop preset. The associate's home is
`/?lhci=associate` only so its URL differs from the admin's `/` — LHCI groups
results by URL.

## Run it locally

You need the API on :3001 with the dev seed (`LOGIN_IP_LIMIT=500 npm -w apps/api run dev`)
for the signed-in pages, and Playwright's Chromium (`npx playwright install chromium`).
The three chart pages (recruiting analytics, labor costs, the call-outs desk) are
only worth measuring with something to draw: `npm -w apps/api run db:seed:analytics`
gives them a year of history (CI runs it before this step).

```sh
npm -w apps/web run build    # the production build → apps/web/dist
npm -w apps/web run lhci     # serves dist, runs all three, asserts, writes reports
```

`lhci` (`lighthouse/run.mjs`) starts `vite preview` on :4173 itself when nothing
is listening there. `vite preview` inherits the dev server's settings from
`vite.config.ts` — host 127.0.0.1 and the `/api` proxy to :3001 — so the built
app talks to the API exactly as it does in development; the preview server
gzips like production. Then it runs `lhci collect` once per run, `lhci assert`,
`lhci upload`, and prints a table of the scores.

| Variable | Default | |
| --- | --- | --- |
| `LHCI_ONLY` | `public,admin,associate` | a subset; `public` needs no API |
| `LHCI_RUNS` | `1` | runs per page; the median is kept (use 3 before tightening a budget) |
| `LHCI_BASE_URL` | `http://127.0.0.1:4173` | measure a server that is already up instead |
| `LHCI_CHROME_PATH` | Playwright's Chromium | |
| `LHCI_ADMIN_EMAIL` / `_PASSWORD`, `LHCI_ASSOCIATE_EMAIL` / `_PASSWORD` | the dev seed's accounts | |

Reports: `apps/web/e2e-results/lighthouse/` (one HTML and one JSON per page,
plus `manifest.json`). Open the HTML in a browser.

## The sweep: every role on a phone, a tablet and a desktop

`lhci` guards a handful of pages in CI. The sweep answers the wider question
("how fast is the app for everyone?") when you ask it: each role's main
pages (associate, driver, supervisor, admin, ops manager, manager, workforce
manager, finance, recruiter, transport director, the client portal's store
and region views, and the public pages), each on three devices.

| Device | Emulation |
| --- | --- |
| phone | Lighthouse's mobile default: Moto G Power, slow 4G (150 ms, 1.6 Mbps), 4× CPU |
| tablet | 820×1180 at 2×, store Wi-Fi: 40 ms, 10 Mbps, 2× CPU |
| desktop | Lighthouse's desktop preset: 40 ms, 10 Mbps, no CPU slowdown |

```sh
npm -w apps/web run build
npm -w apps/web run lighthouse:serve &   # dist over HTTP/2 on https://127.0.0.1:4443
npm -w apps/web run lighthouse:sweep     # ~87 runs, ~30 min
SWEEP_ONLY=associate,admin SWEEP_FORMS=phone npm -w apps/web run lighthouse:sweep
```

It needs the API on :3001 with the dev seed and `LOGIN_IP_LIMIT=500`.
`lighthouse/h2serve.mjs` serves `dist` the way production's edge does: HTTP/2,
gzip, immutable hashed assets, `/api` proxied. Don't measure through `vite
preview`. It speaks HTTP/1.1, and a signed-in page's ~80 chunks queue on six
connections: the associate's home read 6.6 s LCP on a phone that way and 3.9 s
over HTTP/2. The server picks up a new build without a restart.

Results go to `e2e-results/lighthouse-sweep/results.json`, one row per run.
Each row has the metrics plus the evidence: the LCP element and its phases,
the layout shifts, the unused JavaScript, and every script the page fetched,
by chunk name and size.

### 2026-10-24: before and after the first-load work

The same 29 pages on each device, before and after the phone performance pass
(English split by area, charts loaded with their chart, zod and the nav only
where used; see the commit). Medians across the pages:

| Device | Perf | LCP | FCP | Worst CLS | JS (gz) |
| --- | --: | --: | --: | --: | --: |
| phone | 81 → 88 (lowest 77 → 86) | 4.35 → 3.63 s (worst 5.1 → 4.0 s) | 2.55 → 2.10 s | 0.143 → 0.055 | 544 → 381 KB |
| tablet | 100 → 100 | 0.80 → 0.73 s | 0.52 → 0.44 s | 0.038 → 0.010 | 550 → 399 KB |
| desktop | 100 → 100 (lowest 99) | 0.80 → 0.75 s | 0.52 → 0.44 s | 0.025 → 0.005 | 550 → 414 KB |

Each role's home on a phone, plus the slowest pages from before:

| Role | Page | Perf | LCP | CLS | JS (gz) |
| --- | --- | --: | --: | --: | --: |
| public | `/login` | 91 → 94 | 3.0 → 2.7 s | 0 → 0 | 311 → 224 KB |
| associate | `/` | 83 → 88 | 4.0 → 3.7 s | 0.001 → 0 | 492 → 384 KB |
| driver | `/` | 84 → 89 | 3.9 → 3.3 s | 0 → 0 | 471 → 354 KB |
| supervisor | `/` | 79 → 88 | 4.8 → 3.7 s | 0.001 → 0.001 | 626 → 401 KB |
| admin | `/` | 82 → 88 | 4.2 → 3.6 s | 0.001 → 0.001 | 515 → 381 KB |
| ops-manager | `/` | 82 → 87 | 4.2 → 3.6 s | 0.001 → 0.001 | 515 → 381 KB |
| manager | `/` | 80 → 89 | 4.7 → 3.5 s | 0.001 → 0.001 | 595 → 366 KB |
| workforce-manager | `/` | 79 → 88 | 4.7 → 3.7 s | 0.001 → 0 | 607 → 383 KB |
| finance | `/` | 79 → 88 | 4.7 → 3.5 s | 0.001 → 0.001 | 598 → 361 KB |
| recruiter | `/` | 83 → 89 | 4.0 → 3.5 s | 0.001 → 0.001 | 473 → 362 KB |
| transport-director | `/` | 79 → 87 | 4.8 → 3.7 s | 0.001 → 0.001 | 632 → 398 KB |
| portal-store | `/portal` | 80 → 90 | 4.5 → 3.4 s | 0.001 → 0 | 590 → 357 KB |
| portal-region | `/region` | 80 → 90 | 4.5 → 3.4 s | 0.001 → 0.001 | 582 → 350 KB |
| transport-director | `/transport` | 79 → 86 | 4.8 → 3.7 s | 0.001 → 0.001 | 632 → 398 KB |
| workforce-manager | `/scheduling` | 77 → 86 | 5.1 → 4.0 s | 0.001 → 0.001 | 686 → 449 KB |
| public | `/careers` | 82 → 92 | 3.5 → 3.0 s | 0.143 → 0.055 | 363 → 276 KB |

A phone's LCP is now set by the request chain more than by bytes. The chain
runs document → main → `/api/auth/me` → the shell's and page's chunks → the
page's data, each hop a 150 ms round trip on slow 4G. The careers page's
remaining 0.055 is its location and schedule chips, which exist only when
the jobs span places or schedules. It is well inside "good" (< 0.1).

## How the signed-in pages sign in

Every run goes through LHCI's puppeteer hook (`puppeteerScript`, using the
`puppeteer-core` that Lighthouse already ships, so nothing downloads a Chrome).
`lighthouse/login.cjs` opens `/login` once per run, types the persona's email
and password, and checks `/api/auth/me` names that person. The session cookie
lives in the Chrome that Lighthouse then drives. Between pages Lighthouse clears
caches, service workers and IndexedDB (the app's persisted query cache) — every
page is a cold load — but keeps cookies, so the session holds.

## Budgets

In `lighthouse/lighthouserc.cjs`, with today's numbers written above them:

- **Accessibility below 0.95 fails** the run (and the CI job). Every page scores
  100 today, the three chart pages included.
- Performance, best practices, LCP, CLS and TBT are **warnings**, set just past
  today's numbers, so a warning means "worse than on 2026-10-23". Tighten them,
  and turn them into errors, as the pages get faster. The associate's home on
  a phone reads slower here than it is: most of what `lhci` measures there is
  the preview server's HTTP/1.1 queueing ~80 chunks on six connections. Over
  HTTP/2 (the sweep above), the same build measures 3.7 s.
- Phone perf scores move 4–5 points between runs on FCP alone (whether main.js
  ran before the boot splash's first paint in the recorded trace); compare
  medians of 3, never single runs.

The three ECharts pages share the admin desktop budgets. Their numbers on
2026-10-24 (median of 3, local, with `db:seed:analytics` history):

| Page | Perf | A11y | Best practices | LCP | CLS | TBT |
| --- | --: | --: | --: | --: | --: | --: |
| `/recruiting/analytics` (the Sankey) | 95 | 100 | 100 | 1.5 s | 0.002 | 0 ms |
| `/labor-costs` (the treemap) | 94 | 100 | 100 | 1.6 s | 0.010 | 0 ms |
| `/labor-costs?from=…&to=…`, last pay period | 94 | 100 | 100 | 1.6 s | 0.005 | 0 ms |
| `/call-outs` (the calendar heatmap) | 95 | 100 | 100 | 1.5 s | 0.002 | 0 ms |

`/labor-costs` opens on this pay period to date, and that morning was a period's
first day, so its default range held almost nothing; the last-period row is the
same page with fourteen days of rows (measured by hand, not part of the run). One
run in three of it read CLS 0.072 — the sidebar settling, not the report — so
compare medians there too.

## In CI

The **E2E (Playwright, full stack)** job already has Postgres seeded and the API
running. After the Playwright suite it adds the analytics history (`npm -w
apps/api run db:seed:analytics`, after the suite so no spec's expectations move),
builds the web app, runs `npm -w apps/web run lhci`, writes the score table into the job summary, and keeps the reports
as the `lighthouse-reports` artifact (14 days). CI runners are slower than a
laptop, so expect lower performance scores there; the assertions on them are
warnings.

**Reports are never uploaded to temporary-public-storage** (LHCI's free public
host): the signed-in pages show company data. `upload.target` is `filesystem`,
and the only copy leaves the runner as a GitHub artifact, visible to people with
access to the repository.

A private LHCI server (with history and diffs between commits) would need
hosting; nothing here depends on one.
