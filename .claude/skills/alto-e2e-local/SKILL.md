---
name: alto-e2e-local
description: Run Alto People's browser tests (Playwright E2E specs and the axe accessibility sweep) locally against the full stack, the way CI does. Use when an E2E or Accessibility CI job is red, or to check a UI change before pushing.
---

# Browser tests against the local full stack

## The stack
- API on :3001 against alto_dev's demo data, and web (Vite) on :5173. Reuse them if they're up (`curl -s localhost:3001/health`, `curl -s -o /dev/null -w '%{http_code}' localhost:5173`), else from the repo root:
  ```bash
  LOGIN_IP_LIMIT=500 nohup npm -w apps/api run dev > api.log 2>&1 &
  nohup npm -w apps/web run dev > web.log 2>&1 &
  ```
  `LOGIN_IP_LIMIT=500` matters: every spec signs in from one address, and the API also limits 5 sign-ins per email per 15 minutes (sign in once per persona and reuse a storageState in your own scripts).
- Personas (email / password) are in `apps/web/e2e/walkPersonas.ts` and `e2e/personas.ts` (admin@altohr.com / alto-admin-dev, finance@, manager@, dana.reyes@ supervisor, maria.lopez@example.com associate, portal@coastalresort.example…).

## Commands (from apps/web)
- API-mocked specs need no backend: `E2E_BASE_URL=http://localhost:5173 npx playwright test e2e/kiosk-issue-return.spec.ts --workers=1 --reporter=line`
- Full-stack specs: add `E2E_FULLSTACK=1` (hotel-journey, overflow-diag, …).
- The accessibility sweep also needs `A11Y_SWEEP=1`:
  `E2E_FULLSTACK=1 A11Y_SWEEP=1 E2E_BASE_URL=http://localhost:5173 npx playwright test e2e/axe-sweep.spec.ts --workers=1 --reporter=line` (~8 min). Reports: `e2e-results/artifacts/axe-sweep-*/axe-*.json`.
- `E2E_BASE_URL` stops Playwright starting its own dev server.

## Reading results
- Local demo data is richer than CI's fresh seed: the sweep finds more locally (more rows, more states). Fix those too — they'll reach CI as data grows. But a hit that comes only from old local rows (e.g. a September ride notification on the hotel journey) isn't a regression.
- Fix at the source, in the shared component when the pattern repeats (Badge tones, the gold token on light surfaces, chart tooltips, `useListKeyboard`). Don't widen `axe-allowlist.json` unless it's a true false positive, with the reason beside the entry.
- Usual causes:
  - **contrast:** `text-ink-subtle` or `/70`/opacity text, gold on light raised surfaces, past-day opacity;
  - **links:** links inside sentences without `underline`;
  - **tap targets:** under 24px (icon buttons, copy buttons, tiny cells);
  - **ARIA:** `aria-*` that a role doesn't allow, a `<dl>` holding anything but dt/dd/div, `aria-hidden` wrappers holding focusables;
  - **wording:** the hotel journey's forbidden words: a tenant without clients must never read "client", "store" or "Alto". Gate on `useTenant().moduleOn('clientPortal')` and use `useTerm()`.
- The phone overflow guard (`overflow-diag.spec.ts`) skips real scrollers by their computed `overflow-x`; a page wider than 390px is a bug.

## Route sweep (per-persona route smoke)
`e2e/route-sweep.spec.ts` — the 2026-10-29 deep audit's crawler as a test. Per seeded persona (the walk personas + associate + driver) it signs in (session cached in `e2e-results/state/<key>.json`; the login limiter is 5 per 15 min), opens every nav door, and visits every page the nav links to plus the walk's routes — at 1440, and again at 390 for associate, driver, supervisor, portal-store, portal-region and executive. Client-side navigation, read-only (only the nav's "Show … pages" toggles are clicked).
- Run: `E2E_FULLSTACK=1 ROUTE_SWEEP=1 E2E_BASE_URL=http://127.0.0.1:5173 npx playwright test e2e/route-sweep.spec.ts --workers=2 --reporter=line`. Narrow with `ROUTE_SWEEP_PERSONAS=admin,associate`. One persona takes 1–4 min; all thirteen ≈ 20 min.
- Fails on: page errors, the crash screen ("Something broke"), any 5xx, an API 403 on a page the persona's own nav links to, raw "Missing capability" text, the 404 page on a nav-linked route, an `<a href>` matching no App.tsx route, overflow at 390, broken images (failed `<img>` or image answer ≥ 400).
- Run it against a stack nobody is editing (CI, or `vite preview` of a build): on a dev server other sessions are changing, every HMR reload throws a false page error ("useAuth must be used inside <AuthProvider>").
- Report: `e2e-results/route-sweep/<persona>.json` (written after every visit, so a timed-out run keeps its evidence) (every visit, every finding) and attached to the test. A finding you accept goes in `e2e/route-sweep-allowlist.json` (`{ kind, persona?, route?, match?, reason }`) — keep it empty unless a reason is real.
- Usual causes: a route guard looser than its page's first read (align the guard, or skip the read with `useReadable`); a query error rendered from the server's text instead of `QueryError`; an avatar asked for a photo the payload says isn't there (`personPhotoUrl` / `hasPhoto`); a chart's `ResponsiveContainer` imported straight from recharts (use `@/components/ui/charts/container.plot`).
