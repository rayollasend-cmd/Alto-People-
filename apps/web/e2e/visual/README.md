# Visual regression

Seventeen pages, held to an approved picture. A change that moves a pixel on one of
them fails CI ("Visual regression") with the expected, actual and diff images, so a
wording slip (a hotel reading "Client hours"), a contrast drop or a broken layout
shows up in the pull request that caused it.

The older `e2e/visual-walk.spec.ts` and `e2e/design-walk.spec.ts` only *save*
screenshots for a person to look at. This suite *compares*.

## What it covers

| Page | Persona | Desktop 1440×900 | Phone 390×844 |
| --- | --- | --- | --- |
| Sign in (`/login`) | nobody | dark, light | dark, light |
| Admin home (`/`) | admin | dark, light | dark, light |
| Clients list (`/clients`) | admin | dark, light | dark, light |
| A client's Overview (`/clients/:id`, Coastal Resort) | admin | dark | dark |
| People list (`/people`) | admin | dark | dark |
| A person's record (`/people/:id`, Maria Lopez) | admin | dark | dark |
| Scheduling, week (`/scheduling?view=week`) | admin | dark | dark |
| Time & attendance (`/time-attendance`) | admin | dark | dark |
| Payroll home (`/payroll`) | admin | dark | dark |
| Books home (`/books`) | admin | dark | dark |
| Approvals (`/approvals`) | admin | dark | dark |
| Settings › Users & access (`/admin/users`) | admin | dark | dark |
| Recruiting › Analytics (`/recruiting/analytics`, 90 days) | admin | dark | dark |
| Labor costs (`/labor-costs`, on "Last period") | admin | dark | dark |
| The call-outs desk (`/call-outs`) | admin | dark, light | dark, light |
| The associate's home (`/`) | associate (Maria) | — | dark |
| Store portal home (`/portal`) | portal-store | dark | dark |

That is 41 full-page screenshots. The list lives in `pages.ts`; the personas come
from `e2e/walkPersonas.ts`.

Recruiting › Analytics, Labor costs and the call-outs desk hold the ECharts
figures — the Sankey ("How candidates move"), the treemap ("Where the money goes")
and the calendar heatmap ("The year in call-outs") — drawn from the year of
history `npm -w apps/api run db:seed:analytics` writes
(`apps/api/scripts/seed-demo-analytics.ts`). Labor costs is recorded on its "Last
period" preset (`pages.ts` picks it the way a reader does): the report's default,
this pay period to date, can be a day old.

## How it stays deterministic

- **No backend.** Every `/api` response a page made was recorded once into
  `hars/<page>.har` (`record.spec.ts`). The replay (`visual.spec.ts`) answers
  `/api/**` from that HAR with `notFound: 'abort'`, and fails if the page asked for
  anything the recording lacks (it lists the requests).
- **Frozen clock.** `hars/manifest.json` holds each page's recording instant; the
  browser clock is fixed there (`page.clock.setFixedTime`), and the recorder used the
  same frozen instant, so date ranges in URLs and every "today" or "3 hours ago" read
  the same on every run.
- **Same state.** The page's localStorage at recording time (dismissed tours, the
  "New this week" card) is restored before load; the theme is set before load
  (`alto.theme`). Timezone `America/Los_Angeles`, locale `en-US`, a fixed user agent,
  service workers blocked, reduced motion, animations disabled.
- **Loaded, not loading.** Before a shot: network quiet, no `aria-label="Loading"`
  (the auth splash and route fallbacks) and no `aria-busy` skeleton, every ECharts
  box with a size holding drawn shapes (the engine is its own lazy chunk, and the
  figure is drawn an effect after its skeleton goes), fonts ready (`settle.ts`).
  Playwright then takes screenshots until two in a row match.
- **The whole page.** The app scrolls inside `<main>`, not the window, so Playwright's
  `fullPage` alone would stop at the fold. The window grows to the height the page's
  own scroller needs (capped at 6000 px) before the shot, at the same width; the
  recorder does the same, so whatever a taller window loads is in the HAR.
- **Nothing from outside.** Requests to any other origin are blocked.
- **Two endpoints a HAR cannot hold** are answered in code (`live.ts`), the same way
  when recording and replaying: the live-nudge EventSource (`/api/events/stream`, an
  open and silent stream) and the write-only telemetry beacon.
- **No masks.** With the clock frozen and every response recorded, nothing on these
  pages varies between runs.
- **One rendering environment.** The replay always runs in the official image
  `mcr.microsoft.com/playwright:v<installed @playwright/test>-noble`, on
  `linux/amd64`, locally and in CI. The spec refuses to run on a Mac host, where fonts
  and anti-aliasing differ.
- **Greyscale text.** Chromium is launched with `--disable-lcd-text` (in
  `playwright.config.ts`, so recording, `run.mjs` and the CI job all get it). Without
  it Chromium draws text with subpixel antialiasing on an opaque layer and greyscale on
  one it composites on its own, and a page that first paints when `FirstLoadGate`
  reveals it can land either way from run to run: the store portal's desktop shot
  failed on main with 189 px of text edges and nothing else changed. Baselines from
  2026-10-24 on are drawn this way, and three runs in a row matched 33/33; with the
  three chart pages added the same day, three more runs matched 41/41.

Tolerance: no pixel may differ beyond Playwright's per-pixel colour threshold (0.2,
which absorbs anti-aliasing noise): `maxDiffPixels: 0` in `playwright.config.ts`.
Measured when it was set up: 0 differing pixels between the amd64 and arm64 images and
between a Mac-built and a Linux-built bundle; one changed word on the Clients list was
1,400–2,700.

## Commands (from the repo root)

```bash
npm -w apps/web run test:visual          # build, then compare (Docker)
npm -w apps/web run test:visual:update   # build, then rewrite the baselines that changed (Docker)
npm -w apps/web run test:visual:record   # build, then re-record the HARs (local full stack)
```

Extra arguments after `--` go to Playwright, and `--no-build` reuses the last build:

```bash
npm -w apps/web run test:visual -- --no-build -- -g "Clients list"
```

`test:visual` builds the app on the host with `vite build` into
`apps/web/e2e-results/visual-dist` (its own folder, so a parallel `npm run build`
never swaps the bundle mid-run), then starts the Playwright image with the repo
mounted. Inside, `@playwright/test` is installed once into a container-only
`node_modules` volume (`alto-visual-node-modules-linux-amd64`; the host's
`node_modules` hold macOS binaries), `serve.mjs` serves the build with the SPA
fallback, and the replay runs. Docker must be running. On Apple silicon the amd64
image runs under Docker's emulation (about 2.5 minutes for the 33 shots); Chromium's
zygote process dies there, so the config launches it with `--no-zygote` everywhere,
CI included, which does not change what it draws. `VISUAL_PLATFORM=linux/arm64`
runs natively in about 30 seconds and matched the amd64 baselines exactly when this was
set up; still, write baselines with the default (`linux/amd64`, what CI runs).

A failed run writes `apps/web/e2e-results/visual/report/index.html` (expected,
actual and diff side by side) and the raw images under
`apps/web/e2e-results/visual/artifacts/`. In CI the same folder is uploaded as the
`visual-diff` artifact.

## When a page changes on purpose: update the baseline

1. Make the change, then run `npm -w apps/web run test:visual` and read the diff in
   the report: it should show your change and nothing else.
2. Run `npm -w apps/web run test:visual:update`. Only the pictures that no longer
   match are rewritten (`--update-snapshots=changed`).
3. Open the new PNGs under `__screenshots__/` and look at them.
4. Commit them with the change. The PNGs show up in the pull request's diff, and that
   is where a reviewer approves the new look. A baseline change with no reason in the
   PR is a regression until someone says otherwise.

Never update baselines to make an unexplained failure go away.

Several people changing the same pages at once: regenerate the baselines on the
merged code, last, so the pictures match what is committed.

## When an API shape changes: re-record the HARs

A page that starts calling a new endpoint, or reads a new field, needs a new
recording. The replay says so: "requests missing from the recording", with the list.

1. Start the full stack on `alto_dev`'s demo data (see `.claude/skills/alto-e2e-local`):
   API on :3001 with `LOGIN_IP_LIMIT=500`. The three chart pages need the
   analytics history on that database (`npm -w apps/api run db:seed:analytics`;
   a no-op once it's there, `-- --replace` re-anchors it on today). The web dev
   server is not needed: the recorder serves the fresh build on :4799 with `/api`
   proxied to :3001, so it records exactly the requests the bundle under test makes.
   It runs on the host (a HAR holds responses, not pixels), with the host's Chromium
   (`npx playwright install chromium`).
2. Run `npm -w apps/web run test:visual:record`. To re-record a few pages and keep
   the rest: `VISUAL_ONLY=clients,books npm -w apps/web run test:visual:record`.
   Each persona signs in once (logins are rate-limited) and the session is reused
   from `e2e-results/visual/recording/auth/`.
3. Run `npm -w apps/web run test:visual:update`, look at every picture that changed
   (new data moves pixels too), and commit the HARs, `hars/manifest.json` and the
   PNGs together.

The recorder strips cookies, `Authorization` and `Set-Cookie`, timings and every
header except `content-type` and `location`, and refuses to write a HAR with a
credential header left in it. The data in the HARs is the dev seed's demo data.

## Files

- `pages.ts` the pages, forms and themes; `playwright.config.ts` the config both
  specs run under (the E2E and axe jobs never load it, and both specs skip under
  theirs).
- `record.spec.ts` the recorder; `visual.spec.ts` the replay and comparison.
- `har.ts` HAR clean-up and merging; `live.ts` the two endpoints answered in code;
  `settle.ts` "the page has finished drawing" and the full-height window.
- `serve.mjs` the dependency-free static server; `run.mjs` the local entry point.
- `hars/` one HAR per page plus `manifest.json`; `__screenshots__/` the baselines.
