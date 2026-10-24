---
name: alto-ci-triage
description: Find out why Alto People's CI is red on main and fix it — read the failing jobs' logs, tell this change from an older break or a flake, and know the usual causes (bundle size, dependency advisories, axe, hotel wording, date bombs, hung shards). Use whenever a CI run or a Railway build fails.
---

# Triage a red CI

## Look
```bash
gh run list --workflow CI --branch main --limit 6 --json databaseId,headSha,status,conclusion --jq '.[] | "\(.databaseId) \(.headSha[0:8]) \(.status) \(.conclusion)"'
gh run view <id> --json jobs --jq '.jobs[] | "\(.name)\t\(.status)\t\(.conclusion)"'
gh api repos/rayollasend-cmd/Alto-People-/actions/jobs/<jobId>/logs | sed 's/^[0-9TZ:.-]* //' | sed 's/\x1b\[[0-9;]*m//g' > job.log
```
- Compare with the run on the commit before yours: if it already failed the same way, it isn't yours, but fix it anyway.
- **Runs on main queue; they don't cancel each other.** A newer push replaces a *pending* run, never a running one. Wait for completion with an until-loop on the run's jobs, not short sleeps.
- **API shards take 30–70 min** and time out at 100. A shard that times out logs the file it was in (the last `stderr | src/...` line).

## Usual causes and fixes
| Job | Symptom | Fix |
|---|---|---|
| Build + web tests | `size-budget — OVER BUDGET` | Lazy-load what doesn't belong in the first download (split by role, like Dashboard and SchedulingHome). Raise a line in `apps/web/size-budget.json` only on purpose, with the reason in `_comment` and the commit. |
| Build + web tests | `Unaccepted high: <pkg>` from `scripts/dependency-scan.mjs` | `npm update <pkg>` within range. If only a major fixes it, add it to `security/accepted-risks.json` with the advisory, why it's bounded, `acceptedOn`, and an expiry (about 60 days); plan the upgrade. |
| Build + web tests | an unhandled error with all tests passed | A timer or rAF firing after its test ended (stub the API in `test/setup.ts`, or clean up). |
| E2E | the hotel journey's forbidden words | Gate client wording on `useTenant().moduleOn('clientPortal')`; use `useTerm()`. |
| E2E | a spec expecting old markup or URLs | Update it to the new behaviour (People has no drawer; `?return=` on links). |
| Accessibility | axe findings | Skill `alto-e2e-local`; fix at the source. |
| API shard | fails in CI, passes locally | A date bomb (UTC vs the company calendar), queued side effects, or ordering. See skill `alto-api-tests`. |
| Visual regression | screenshots moved | Skill `alto-visual`: an intended change gets `test:visual:update` and its PNGs committed; an unintended one gets fixed. |
| Railway build | heap out of memory | The API build runs tsc with `--max-old-space-size=6144` (apps/api/package.json). |
| Railway build | `failed to solve: secret <Word> not found`, right after "install apt packages" | Railpack passes every service variable to the build as a secret, and a variable name with a space breaks that (`Railway source maps` → secret `Railway`). List the names (`railway variables --json`, names only) and rename the bad one to a real env name. |

## Verify production after a fix lands
`curl -s https://people.altohr.com/api/health/version` shows the deployed SHA, and `/api/health/ready` should be `{"ok":true,"db":"ok"}`. Railway deploy status is on the GitHub deployment for the SHA (`gh api repos/rayollasend-cmd/Alto-People-/deployments`).
