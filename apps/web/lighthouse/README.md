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
  and turn them into errors, as the pages get faster. Where to start: the
  associate's home on a phone (LCP 6.6 s here; most of it is the preview
  server's HTTP/1.1 queueing ~70 chunks on six connections — over HTTP/2 the
  same build measures 3.9 s).
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
