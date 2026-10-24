---
name: alto-api-tests
description: Run Alto People's API test suite — one file on its own database, or the full suite as four parallel shards — and tell a flake from a regression. Use before committing API changes, or when a test fails.
---

# Running the API tests

The API tests run against Postgres (docker container `alto-people-postgres`, user `alto` / `alto_dev`) in schema `alto_test`. `test/globalSetup.ts` runs `prisma migrate deploy` and takes a per-database advisory lock, so **two runs on one database serialize**: give each run its own database.

## One file or a few
```bash
docker exec alto-people-postgres psql -U alto -d alto_dev -c "CREATE DATABASE alto_t_mine;"   # once
cd apps/api
ALTO_TEST_DATABASE_URL="postgresql://alto:alto_dev@localhost:5432/alto_t_mine?schema=alto_test" npx vitest run src/__tests__/routes/x.test.ts
```
Name filters work too: `npx vitest run clients inbox recruiterBoundary`.
Always add the guards when you touched routes or models: `src/__tests__/tenancy/` (siteScope, crossTenant, rlsWall), `testIsolation`, and the area's route tests.

## The full suite (≈12 min a shard locally)
1. Back up dev first, then turn fsync off — concurrent suites crawl on TRUNCATE fsync:
   ```bash
   docker exec alto-people-postgres pg_dump -U alto -Fc alto_dev > <scratchpad>/backup/alto_dev-$(date +%F).dump
   docker exec alto-people-postgres psql -U alto -d alto_dev -c "ALTER SYSTEM SET fsync = off;" -c "SELECT pg_reload_conf();"
   ```
2. Four fresh databases and four shards in the background, plus the web suite:
   ```bash
   for i in 1 2 3 4; do docker exec alto-people-postgres psql -U alto -d alto_dev -c "DROP DATABASE IF EXISTS alto_t_m$i WITH (FORCE);" -c "CREATE DATABASE alto_t_m$i;"; done
   cd apps/api
   for i in 1 2 3 4; do ALTO_TEST_DATABASE_URL="postgresql://alto:alto_dev@localhost:5432/alto_t_m$i?schema=alto_test" npx vitest run --shard=$i/4 > shard$i.log 2>&1 & done
   (cd ../web && npx vitest run > web.log 2>&1) &
   wait
   ```
3. **Always undo:** `ALTER SYSTEM RESET fsync; SELECT pg_reload_conf();` and drop the `alto_t_*` databases.

## Reading failures
- `grep -E "Test Files|^      Tests |^ FAIL " shard*.log`, then **rerun every failing file alone** on one database.
- **Passes alone** → a load flake (socket hang up, "too many clients", a login 400/429 under load). Expect 0–4 a full run.
- **Fails alone** → real. Common real causes:
  - **date bombs:** a test seeds dates from UTC (`toISOString().slice(0,10)`, or a DATE column given `new Date()`) while the code counts on the company's calendar (`orgDateKey`). It fails only after 5 PM Pacific, and some only on Friday evenings, when UTC's Saturday is the next store week (Sat→Fri). Seed with the company day, or pin `Date` with `vi.useFakeTimers({ toFake: ['Date'] })`. Web tests that read the clock (greetings: "Up late" midnight–5 AM, "Good morning/afternoon/evening", "Burning the midnight oil" 10 PM–midnight; CI runs in UTC) must accept every state. A shift seeded "later today" as `Date.now() + 1 * H` is tomorrow once it's past 11 PM on the company calendar or in the store's zone (sites default to America/New_York, i.e. after 8 PM Pacific); seed it to start now, or clamp to the day's end. Simplest for any test asserting on today or this week: call `pinMidweekNoon()` (test/clock.ts) first — it pins `Date` to the most recent Wednesday noon Eastern for that test only.
  - **queued side effects:** audits and notifications are fire-and-forget. Read them after `flushPendingAudits()` / `flushPendingNotifications()`.
  - **random order:** UUID-ordered rows (an 834's members, say). Find the row by name, not position.
  - **a test that encodes old behaviour** after an intended change: update it, and say so in the commit.
- `npm run typecheck:test` (in apps/api) type-checks the tests, which `tsc -p` doesn't.
