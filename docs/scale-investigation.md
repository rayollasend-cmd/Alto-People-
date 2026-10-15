# Scale, uptime, accessibility and languages — brief 3-6

Build report for the four deliverables of brief 3-6. One commit on branch
`worktree-agent-a1f94acbed673fbad` (branched from `7eee63fa`); not pushed.

## 1. Load test harness

**Where.** `apps/api/scripts/load/` (`scale.ts` constants, `seed-scale.ts`,
`run.ts`), the pure parts in `apps/api/src/lib/loadHarness.ts` with their unit
test in `apps/api/src/__tests__/lib/loadHarness.test.ts`, and the workflow
`.github/workflows/load-test.yml` (`workflow_dispatch`, inputs `workers` and
`sites`, defaults 50,000 / 1,000).

**Scale seed.** Opt-in only: `LOAD_SCALE=1 tsx scripts/load/seed-scale.ts`
refuses to run otherwise, and marks the database with an audit row so the
runner can tell a scale database from the demo one. Deterministic (`Rng(360000)`
from `lib/demoSeed`), `createMany` in chunks of 2,000: 1,000 sites, 50,000
associates with open assignments, one `Worker` per person, 2,000 associate
logins sharing one argon hash (`load-associate-2026!!`), and three shifts per
site for today with an explicit `workerId` so the `db.ts` extension is not
paid 150,000 times.

**Scenarios.** Twelve routes, each run by N concurrent fetch loops until the
deadline: sign-in (rotating emails, `LOGIN_IP_LIMIT` lifted in the workflow),
`/auth/me`, `/me/decisions`, the associate's shifts window, clock-in
(200/201/409 all count as served), the admin active-time board, conversations
and posting a message, pending clock-in requests, the people directory,
`/workers`, and the public status page.

**Report and gate.** `renderReport` writes p50 / p95 / p99 / RPS / failure
rate per scenario into `load-report.md` (uploaded as an artifact and shown in
the step summary) and the job fails when any scenario's p95 exceeds
`P95_BUDGET_MS` (2,000 ms) or its failure rate reaches 1 %.

**Deviation from the brief.** The brief suggested autocannon. The runner is a
plain `fetch` loop instead: no new dependency, exact nearest-rank percentiles
from the raw sample instead of autocannon's histogram buckets, and per-worker
cookies (autocannon shares one). Swapping it in later is a one-file change.

**Numbers.** None measured locally: this machine has no Postgres, so the seed
and runner only execute in CI. The first `workflow_dispatch` run produces the
baseline table; the budget is the brief's 2,000 ms p95, not a number derived
from a run.

**Bottleneck found by reading.** Every hot route already had an
`(owner, time)` index except the people directory, which sorts 50,000
associates by last name, first name, id. Migration
`20261208100000_scale_indexes` adds `Associate(lastName, firstName)`; the
schema carries the matching `@@index`. Nothing else was changed in advance of
measurement.

## 2. Failover test

**Where.** `.github/workflows/failover-test.yml` and
`apps/api/scripts/failover/probe.sh`.

**What it does.** Starts the built API against the CI Postgres service, probes
`GET /api/health/ready` every 500 ms for 90 s, restarts the Postgres container
at t = 20 s, and reports the interruption as first failed probe to first
subsequent success. Budget 60 s; the job also fails if the API never recovers.
The log and a Markdown report are uploaded.

**What changed in the API.** `routes/health.ts` now has two answers.
`/api/health` stays liveness only (never touches the database, so an
orchestrator does not restart the process for a database blip).
`/api/health/ready` runs `SELECT 1` with a 2 s timeout and returns 503
`{ db: 'down' }` until the pool reconnects — the honest readiness answer the
brief asked for. Reconnection itself needs no code: Prisma's pool drops the
broken connections and dials again on the next query, and the existing retry
wrapper in `db.ts` already covers `P1001` during the gap.

**Neon / Railway expectations (owner to confirm).**
- Point Railway's health check at `/api/health/ready`, not `/api/health`, so a
  deploy only switches traffic once the database is reachable from the new
  instance.
- Neon's compute is single-zone per branch; its storage is replicated across
  zones. A compute restart (autosuspend wake, maintenance) looks exactly like
  the restart this test performs: expect the same tens of seconds, not a
  silent failover. Keep `DIRECT_URL` on the non-pooled endpoint for migrations
  and `DATABASE_URL` on the pooler.
- Railway restarts replace the container; a Railway region outage is not
  covered by anything here. Multi-region needs a second service plus a
  database that follows — a decision, not a workflow.

## 3. Translation workflow

**Gate.** `apps/web/scripts/i18n-check.mjs`, wired as `npm -w apps/web run
lint:i18n` and as a CI step after the design lint in the web build job. It
reads the six dictionaries, the 61 associate-facing files listed in
`scripts/i18n-associate-files.txt`, and fails when an associate-app key is
missing from any language, when a key is used but never defined, or when the
count of hard-coded user-visible strings in those files rises above
`scripts/i18n-baseline.json` (per-file counts that may only fall; `--write`
locks a lower number in). `scripts/i18n-allowlist.json` holds the regexes for
brand names, form numbers, weekdays and the like.

**Languages.** `Lang` is now `en | es | tr | ht | pt | uk`; the picker in the
mobile nav lists all six; `detectLang` honours a stored or browser language
for any of them. Each new language lives in `apps/web/src/lib/i18n/<lang>.ts`
and holds exactly the 1,648 associate-app keys (admin-only keys are not
translated and fall back to English). The account language the server emails
in stays EN/ES/TR, so `LanguageSync` only pushes those three upstream.

| Language | Keys | Status |
|---|---|---|
| Turkish | 1,648 associate + 48 existing | Machine-drafted, marked for a native speaker's review |
| Haitian Creole | 1,648 | Machine-drafted, marked for review |
| Portuguese (Brazil) | 1,648 | Machine-drafted, marked for review |
| Ukrainian | 1,648 | Machine-drafted, marked for review |

Every module opens with a review banner. Payroll, direct-deposit, I-9 / W-4 and
ride-charge authorization copy must be reviewed by a human before these
languages are offered to associates; until then the picker should stay behind
the owner's go. Six nav and theme labels that were hard-coded English in the
mobile nav and tab bar now go through keys in all six languages; the baseline
starts at 114 remaining hard-coded strings (Learning, KB, Marketplace,
Agreements, Settings carry most of them).

## 4. Accessibility checklist (keyboard-only, read and fixed)

Walk each screen with Tab / Shift-Tab / Enter / Space / Escape only; no mouse.

1. **Home** — the decision rows reach by Tab in reading order; the "More"
   tab announces its purpose; focus returns to the opener after a sheet closes.
2. **Schedule** — list / week / month segmented control is a radio group;
   each shift card is one focus stop; the swap dialog traps focus (Radix
   `Dialog`) and returns it.
3. **Clock / timesheet** — the range chips are a labelled group; "Report an
   issue" opens a dialog; focus should land inside it (Radix moves it to the
   first focusable control) — confirm by hand, no `autoFocus` is set.
4. **Pay** — the earnings hero is not a focus trap; the paystub rows are links
   or buttons, never clickable divs.
5. **Messages** — Enter sends on a keyboard device
   only (fine pointer), Shift-Enter breaks a line; the thread list is a list.
6. **Kiosk** — digits, Backspace, Escape and Enter now work from a physical
   keyboard (`PinPad` keydown handler); every keypad control is
   `type="button"`; errors announce via the existing `aria-live` region.

Fixed in this commit: kiosk keypad keyboard entry and button types; mobile nav
dialog label, close button and theme toggle labels translated; bottom tab bar
landmark label translated. Verified by reading, not by a screen reader: Radix
dialogs trap and restore focus; the tab bar sets `aria-current`.

## What runs only in CI

The scale seed, the load run, the failover probe and the harness unit test
(vitest needs a Postgres schema). Run locally: web eslint, web tsc, design
lint, i18n check (ok, 1,648 keys, debt 114), API `tsc -p` and
`typecheck:test`, `prisma validate`.

## Open questions

1. Who reviews the four drafts, and in what order? Payroll copy first.
2. Should the Railway health check move to `/api/health/ready` now, before
   the next deploy?
3. The load budget is a single p95 line. Once the first run exists, should the
   gate become a ratio against that baseline instead?
4. The hard-coded-string heuristic only sees JSX text and five attributes;
   strings built in helpers escape it. Worth a lint rule later.

## First baseline (2026-10-15, run 7 of the load-test workflow)

50,000 workers across 1,000 sites, one GitHub runner, the API's production build against the runner's Postgres. Budget: p95 under 2,000 ms and under 1 percent failures on every route. **Pass.**

| Route | Requests | RPS | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| Sign in | 950 | 94.5 | 105 | 125 | 139 |
| Session (/auth/me) | 17,173 | 1,716 | 14 | 23 | 31 |
| Home decision queue | 647 | 64 | 155 | 183 | 197 |
| Schedule, one week | 60 | 5.7 | 1,770 | 1,850 | 1,899 |
| Clock in at the kiosk, shift change | 200 | 18.2 | 88 | 149 | 164 |
| Time & attendance, live | 8,395 | 839 | 12 | 16 | 19 |
| Messages, conversations | 7,038 | 703 | 14 | 18 | 23 |
| Messages, send burst | 1,815 | 181 | 55 | 70 | 79 |
| Approvals, walk-in queue | 5,359 | 535 | 18 | 26 | 36 |
| People directory | 230 | 22.7 | 440 | 489 | 514 |
| Control room poll, one site | 312 | 30.5 | 647 | 722 | 801 |
| Control room poll, status | 4,960 | 495 | 40 | 53 | 66 |

The failover workflow's first run the same day: Postgres restarted at 20 s under probing, one probe failed, interruption 2.26 s against the 60 s limit.

What the runs before this one found and fixed, in order: production boot refuses to start without MFA_SECRET_ENCRYPTION_KEY and KIOSK_PIN_SECRET (the workflow carries throwaway values at job level); a shell line continuation handed the secrets to npm; associates are never in the messenger, so the burst writes to the first person the admin may message; the per-user API cap of 600 a minute called one runner a loop (DEFAULT_API_LIMIT, like LOGIN_IP_LIMIT, exists for this stack only); associates clock in at the kiosk, so the scale seed registers twenty kiosks with one PIN each and the scenario punches a second apart per device; the active definition negated a status while filtering 50,000 ids, which Prisma could not split and Postgres refused (the people directory answered 500 and the billing usage tick failed) — it reads evidence in batches of 10,000 now; and the directory computed every associate's standing per page (five seconds) — it asks about its page's rows now.

Still slow enough to watch: the one-week schedule at 1.8 s p95 on 50,000 shifts and the per-site control room at 0.7 s. The workers roster at `/workers` returns up to 5,000 rows with their placements in about 4 s and is not on the list; it needs server-side paging before a tenant that size opens it.
