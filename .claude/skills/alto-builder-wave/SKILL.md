---
name: alto-builder-wave
description: Run a large Alto People change as parallel builder agents in one working tree and merge it safely — briefs, file ownership, per-builder databases and migration prefixes, the merge gates, the full test run, and committing onto a fast-moving main. Use for any job too big for one pass (an audit's findings, a multi-area rebuild).
---

# Parallel builders, one tree, one merge

## Before launching
1. **Commit and push whatever is already finished.** A later `git add -A` sweeps every builder's half-done files into whatever you commit.
2. **Write a COMMON brief** (copy the last one in the session scratchpad: house rules, tests, screenshots, report format) plus **one brief per builder** naming:
   - the files it owns, and the files it must not touch;
   - its test database (`alto_<wave>_<key>`), created up front;
   - its migration prefix: one timestamp block per builder, after origin's newest;
   - the exact spec (findings, items), with "build everything; skip only with a stated reason".
3. **Shared files** (`schema.prisma`, `app.ts`, `App.tsx`, `lib/modules.ts`, i18n packs, `packages/shared/src/contracts.ts`): additive edits only, re-read the region before each edit, never overwrite.
4. **Builders never run git commands that change the tree or index.** They run their own files' tests plus the guards (tenancy/, siteScope, testIsolation), never the full API suite: four builders × four shards exhausts Postgres's 100 connections.
5. **Save a memory note** with the plan and how to resume (lights-out insurance). Builders hit session limits; resume them with SendMessage, adding the known breakage in their area.

## When builders report
- Save each report from its final message into the scratchpad. Collect "left for X" items, owner questions and production-visible changes.
- Relay cross-builder contracts (e.g. one shared query key) with SendMessage.

## The merge
1. `npm -w @alto-people/shared run build`; `prisma generate`; `prisma validate`.
2. Gates: API `tsc --noEmit` + `npm run typecheck:test`; web `tsc -b`; eslint (api and web); `node scripts/design-lint.mjs` (run `--write` only to lock in reductions); `node scripts/i18n-check.mjs`; shared tests.
3. **The full suite as four shards** (skill `alto-api-tests`): rerun every failure alone; fix the real ones; flakes pass alone.
4. **Review data-rewriting migrations yourself** (FKs that cascade, triggers, live-data safety). Back up dev and test them on a restored copy.
5. **Commit with a message that says what users get**, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
6. `git fetch`. If origin moved, `git rebase origin/main`, resolve conflicts keeping both sides' intent, re-run typecheck/lint and the affected tests, then push. A push to main deploys to Railway: check `https://people.altohr.com/api/health/version` shows the new SHA and `/api/health/ready` is ok.
7. Reset fsync, drop the wave's databases, update the memory note.
