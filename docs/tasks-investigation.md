# Brief 3-2 — Tasks and the assignment engine

Built 2026-10-15 on the owner's instruction to complete Phase 3 without stopping. This is the record of what was decided, what already existed, and what remains for the owner.

## What exists

Work is modelled as tasks. A task is one unit of work at one site, in a time window, needing one capability from the worker catalog (`WORKER_CAPABILITIES`): "Unload the 6 AM truck", at the receiving dock, 6:00–8:00, `unloading`, high risk, 90 minutes, truck 4471. The engine ranks every worker who could take it — the people on shift at the site in the window, the tenant's agents, its robots — and either assigns the best one or queues the task for a person with the reason. Every assignment keeps every factor it weighed, with points and a line a supervisor can read, and the whole ranking including the candidates it passed over and why.

| Piece | Where |
|---|---|
| Models `WorkTask`, `WorkTaskAssignment` (reasons + ranking JSON), `WorkTaskEvent`, `WorkTaskPolicy` | `apps/api/prisma/schema.prisma`, migration `20261205100000_tasks` |
| The pure ranker: `rankCandidates`, `decideAssignment`, `decideHandoff` | `apps/api/src/lib/tasks/rank.ts` |
| The database side: candidates, pricing, writing decisions, the handoff, views | `apps/api/src/lib/tasks/engine.ts` |
| The robot seam for Brief 3-1 | `apps/api/src/lib/tasks/robotAvailability.ts` |
| The 15-second handoff sweep, per tenant | `apps/api/src/lib/tasks/sweep.ts` (started in `index.ts`) |
| Routes under `/tasks` | `apps/api/src/routes/tasks.ts` |
| Shared types and schemas | `packages/shared/src/tasks.ts` (`WorkTask*` names: the onboarding checklist already owns `TaskStatus`) |
| The board (List template), the drawer with the reasons, the new-task dialog | `apps/web/src/pages/tasks/` at `/tasks` (Operations group) |
| The policy page under Settings & Trust › Organization | `apps/web/src/pages/tasks/TaskPolicyPage.tsx` at `/admin/task-policy` |
| Acceptance: the banquet (5 associates, 3 robots) on the pure ranker; the same through the API with the sweep | `apps/api/src/__tests__/lib/workTaskRank.test.ts`, `apps/api/src/__tests__/routes/tasks.test.ts` |
| The board's states | `apps/web/src/__tests__/pages/TasksBoard.test.tsx` |
| Demo data: eight tasks at Front Beach 218 through the real engine | `apps/api/scripts/seed-demo.ts` |

## Decisions

1. **The ranking is a pure function.** `rank.ts` takes the task, the candidates and the policy and returns the ranking and the decision; `engine.ts` only gathers and writes. The acceptance test runs in a unit test without Postgres and again through the API.
2. **Scoring.** Capability 40 points (not certified = ineligible), availability 30 (not free = ineligible), cost 20 scaled from the cheapest eligible to the dearest, −5 per task already held in the window, −15 for a robot under 30 % battery. Risk is a gate, not points: high-risk work goes to a person, or to a robot only when the policy allows it and a person is on shift at the site to supervise. Ties break on cost, then name. Ineligible candidates stay in the ranking with their reasons: "why not the robot" is half of explainability.
3. **People are on shift or they are not.** A person is a candidate when they hold an assigned shift at the site that overlaps the window; their cost is the shift's resolved pay rate (explicit, rate card, or the org standard) times the estimate. Agents are candidates when ACTIVE, at the policy's agent cost (default $0). Robots come through the seam below.
4. **The policy** is one row per tenant (locationId null) with optional per-site overrides: handoff seconds (default 30), a cap on what the engine assigns on its own (none by default; dearer work queues for a person), the high-risk rule, robot cost per task by capability with a default ($4.00), agent cost, and the robots-per-crew-lead span Brief 3-3 reads.
5. **The handoff.** A machine's task that stalled or failed waits the policy's seconds, then the sweep (every 15 s per tenant) hands it to the best PERSON on shift — never another machine — records the handoff as the first reason, releases the machine's assignment into the history, and tells the crew leads: supervisors placed at the site, else the tenant's workforce and operations managers. The "Hand to a person" action does the same at once. With 30 seconds and a 15-second sweep the task is in a person's hands within 45 seconds; the acceptance test proves the decision and the timing bound.
6. **Robot seam.** `robotAvailability(db, workerId)` answers availability, a note and battery from the Worker row (ACTIVE = running, battery unknown). Brief 3-1 replaces its body with the fleet connector's latest reading and keeps the signature; the ranker already weighs battery.
7. **Names.** `TaskStatus` and `Task` already belong to the onboarding checklist, so the models and shared types are `WorkTask*`; the product says "task".
8. **Access.** Reads need `view:scheduling`, writes `manage:scheduling`, the policy `manage:org`. Everything is the caller's tenant; a second tenant's admin gets 404 on a task and an empty board.

## Open questions for the owner

- Robot cost per task by kind of work: $4.00 is a placeholder until the pilot's lease or ownership numbers arrive (Brief 3-1 carries the lease field).
- Should a stalled robot's task wait longer than a failed one? Today one number covers both.
- Crew lead: a supervisor placed at the site. If a site has none, the workforce and operations managers hear instead; say if the fallback should be narrower.
