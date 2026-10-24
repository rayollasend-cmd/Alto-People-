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
