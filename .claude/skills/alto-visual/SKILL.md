---
name: alto-visual
description: Alto People's visual regression screenshots — check a UI change against the approved pictures, approve an intended change, or re-record a page's data. Use when the "Visual regression" CI job fails, or after changing any of the 14 covered pages (sign-in, admin home, Clients, client Overview, People, person record, Scheduling, Time, Payroll, Books, Approvals, Users & access, associate home, store portal).
---

# Visual regression

Each covered page is served from a recording of its API responses (`apps/web/e2e/visual/hars/`), with the browser clock frozen at the recording instant. It's rendered in the official Playwright Linux image and compared with the approved PNGs in `apps/web/e2e/visual/__screenshots__/`. The comparison allows zero differing pixels beyond Playwright's per-pixel colour threshold. Full details: `apps/web/e2e/visual/README.md`.

## Commands (repo root; Docker must be running)
- **Compare:** `npm -w apps/web run test:visual` (about 2.5 min). It builds with Vite on the host and compares inside `mcr.microsoft.com/playwright:v<installed @playwright/test>-noble`.
- **Approve an intended change:** `npm -w apps/web run test:visual:update`. It rewrites only the shots that moved. **Look at every changed PNG** (Read it) before committing. The new pictures show in the PR or commit diff, and that diff is the review.
- **Re-record a page's data** when an API response shape changes: `npm -w apps/web run test:visual:record` (needs the local API on :3001 with alto_dev's demo data; `VISUAL_ONLY=clients,books` limits it). Then run `:update`. Recordings strip cookies and auth headers. Check that no secrets landed in a HAR before committing.

## When CI's "Visual regression" job fails
1. Download the `visual-diff` artifact: it has the expected, actual and diff images and an HTML report.
2. **Unintended change:** fix the code.
3. **Intended change:** run `:update` locally, look at the PNGs, and commit them with the change.
4. If the job fails at once with a missing browser, the image tag in `.github/workflows/ci.yml` must move together with `@playwright/test`.

## Gotchas
- On Apple Silicon the amd64 image runs under QEMU. The config passes `--no-zygote` (it doesn't change what's drawn).
- The app scrolls inside `<main>`, so the spec grows the window to the page height (capped at 6,000 px) for full-page shots.
- The live-updates stream and the telemetry beacon are answered in code (`live.ts`), not recorded.
