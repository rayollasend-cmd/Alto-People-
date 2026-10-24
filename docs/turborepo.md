# Turborepo

The root scripts run through [Turborepo](https://turborepo.com) (`turbo`, a root
dev dependency). `turbo.json` says what each task needs and makes; turbo runs the
tasks in dependency order and keeps a local cache, so a package whose inputs did
not change is restored from the cache (its output files and its log), not run
again.

```sh
npm run build        # turbo run build --concurrency=1
npm run typecheck    # turbo run typecheck
npm run lint         # turbo run lint lint:design lint:i18n
npm test             # turbo run test --concurrency=1
npm run build:web    # one package (and what it depends on): build:api, build:shared too
npm run test:web     # likewise test:api, test:shared
npx turbo run build --force   # ignore the cache
```

## The tasks

| Task | Packages | Waits for | Cached outputs |
| --- | --- | --- | --- |
| `db:generate` | api (`prisma generate`) | — | never cached: it writes the Prisma client into `node_modules`, which no cache can restore; runs every time (seconds) |
| `build` | shared, web, api | shared's build (`^build`); api also `db:generate` | `dist/**` |
| `typecheck` | web (`tsc -b` + `.storybook`), api (src + tests), shared | `^build`, `db:generate` | — |
| `lint`, `lint:design`, `lint:i18n` | eslint in all three; the two gates in web | — | — |
| `test` | shared, web | `^build` | `coverage/**` |
| `test` (api) | api | `^build`, `db:generate` | never cached: it runs against a database |
| `build-storybook` | web | `^build` | `storybook-static/**` |
| `test-storybook` | web | `^build` | — |
| `test:visual` | web | `^build` | never cached |

A task's cache key is the hash of its package's files (git-tracked and
untracked-but-not-ignored), `tsconfig.base.json`, the lockfile entries it uses,
the keys of the tasks it waits for, `NODE_ENV`, and for the web build `VITE_*`
and `SENTRY_*`. The web build ignores `e2e/`, `lighthouse/` and Markdown, which
never reach `dist`.

`envMode` is `loose`: every task sees the whole environment, as plain `npm run`
did (Railway's `DATABASE_URL`, `VITE_*` and `SENTRY_*` reach the builds); only
the variables named above change a cache key.

## Railway builds exactly as before

`railway.json` runs `npm install && npm run build`. The root build is now
`turbo run build --concurrency=1`:

- the same three package builds, through each package's own `npm run build`, so
  the API still runs its `prebuild` (`prisma generate`) and its `tsc` (since
  2026-10-23 TypeScript 7, the native compiler in
  `node_modules/typescript-native` — no heap flag), and the web still fetches
  the face models and runs `tsc -b && vite build`;
- one at a time, as before (`--concurrency=1`): shared first, then api and
  web in whichever order turbo picks (the old script always did web before
  api; neither reads the other's output — the API finds `apps/web/dist` at
  run time). Parallel builds would put the API's typecheck (~3.5 GB with
  TypeScript 7's four checkers) next to the web build on the same builder;
- Railway's builder starts with no `.turbo/cache`, so everything is built.

Checked on 2026-10-23: from a clean clone, `npm install && npm run build`
produced `apps/api/dist` and `packages/shared/dist` byte-identical to the old
script's, and `apps/web/dist` identical apart from the build stamp in
`sw.js`/`asset-manifest.json` and the order of the two font `<link rel=preload>`
tags in the HTML (that order already varied between plain `vite build` runs).

Turbo needs to know the package manager. That comes from `devEngines` in the
root `package.json` (npm `^11.0.0`, `onFail: "warn"` — a different npm only
warns), not from a `packageManager` field, which Railway's builder reads to
choose the npm it installs with.

## Timings (local, Apple silicon, 2026-10-23)

A clean clone, `npm install` done, no `dist`, two rounds each:

| | Time |
| --- | --- |
| Old script (`npm -w … run build` × 3) | 78 s, 81 s |
| `npm run build`, cold (empty cache) | 87 s, 89 s |
| `npm run build`, warm (nothing changed) | 10 s, 6 s |

Cold costs about 8 s more than the old script: the extra uncached
`prisma generate` and writing the three `dist` folders into the cache. Warm is
only `prisma generate` plus restoring the folders. Change one package and only
it (and what depends on it) rebuilds: a web-only change skips the API's
typecheck, an API-only change skips the web build.

`npm run typecheck` + `npm run lint` (all ten tasks): 51 s cold, 6 s warm.

Those were TypeScript 5. After the TypeScript 7 merge (same day) a cold
`npm run build` takes ~32 s and a cold `npm run typecheck` ~12 s.

## In CI

The **Build + web tests** job restores `.turbo/cache` with `actions/cache`
(saved under the commit's SHA, restored from the newest earlier save), then
runs the build, `turbo run lint lint:design lint:i18n typecheck`, and the web
and shared unit tests through turbo. A pull request that touches only the API
restores the web build and the web suite instead of running them.

Other jobs (API shards, E2E, accessibility, Storybook) still call their
packages' scripts directly; they build little and gain little from the cache.

## Remote cache (not set up)

Turbo can share one cache between every machine and CI run (Vercel Remote
Cache). That needs a Vercel account, so it is off. To turn it on:

1. Create a Vercel team (free tier works) and an access token with access to it.
2. Add two repository secrets: `TURBO_TOKEN` (the token) and `TURBO_TEAM` (the
   team's slug).
3. In `.github/workflows/ci.yml`, give the turbo steps
   `env: { TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}, TURBO_TEAM: ${{ secrets.TURBO_TEAM }} }`.
   The `actions/cache` step can then go.
4. Locally: `npx turbo login && npx turbo link`.

Do not add it to Railway: a deploy should build from source.
