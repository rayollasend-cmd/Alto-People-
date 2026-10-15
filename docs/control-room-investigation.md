# Brief 3-3 — Control room and the hybrid season planner

Built 2026-10-15 on the owner's order to complete Phase 3 without stopping. One screen per site of every worker on shift (person, agent, robot), the span of control, and a planner that proposes the people-robot mix from demand expressed as tasks.

## What was built

**The seam (3-1 ↔ 3-2).** `lib/tasks/robotAvailability.ts` now answers from the registry: the worker's status (an emergency stop suspends it), the fleet connector's latest reading (status, battery, age — a reading older than 30 minutes is no reading), a maintenance item past its due date, and the commissioning sign-off at the robot's site. The assignment engine's battery and maintenance factors are real; an unavailable robot stays in the ranking with the reason.

**Span of control.** `lib/tasks/spanOfControl.ts`: a pure `spanOfControl(robots, leads, maxPerLead)` and the readers `robotsOnShiftAt` (robot shifts covering the instant) and `crewLeadsOnFloor` (people clocked in whose account holds a lead role or whose worker is certified for supervision). The policy's `maxRobotsPerCrewLead` (3-2's row) is the limit. A robot shift start (`startRobotShift`) and an engine assignment to a robot (`POST /tasks`, `/tasks/:id/auto`) return `warnings[]`; the record page and the task board show them as caution toasts. Never a block: the floor decides.

**The control room.** `GET /control-room?locationId=` (`lib/controlRoom.ts`, `routes/controlRoom.ts`, mounted behind the scheduling module, `view:scheduling`): people on assigned shifts now with their punch (on the floor, late past fifteen minutes, crew lead), robots placed at or on shift at the site with the fleet reading, agents of the organization with the switch, exceptions (stalled, failed and handed-off tasks, robots in error, stopped or offline on shift, shifts in the next two hours nobody confirmed, no-shows in the last day, zones occupied while a robot is on shift), what waits for a person (agent approvals, tasks queued), the site's zones, the span, and a strip. `GET /control-room/sites` lists what the person may watch (bounded roles see their own site or client).

The page (`/control-room`, Operations group, `pages/controlRoom/ControlRoomPage.tsx`) is a Desk: site picker and crew filter in the header, the live strip, the span, the floor (the zones as the rectangles the zones editor draws, each robot at its last reading; people have no position — a punch says they are here, not where — so they sit in a rail beside the map and the page says so), the exceptions with "Hand to a person" on a stalled or failed task, what waits, then the workers by kind with Emergency stop / Resume per robot (a reason, on the log) and Suspend all agents / Resume (manage:org, the Agents page's dialog). Polls every 15 seconds. Targets are 44px on a coarse pointer; status is never colour alone.

**The hybrid planner.** `SeasonPlanSite.taskDemand` (`[{ week, tasks: [{ capability, count, minutes, risk }] }]`) beside the headcount demand; `WorkTaskPolicy.robotUtilizationPct` (70) and `backupCrewRatioPct` (25). `lib/tasks/mix.ts` is a pure `proposeMix`: robots take the task minutes they are certified for, within the risk policy, shortest tasks first, up to robots × days × shift minutes × utilisation; people take the rest. Outputs per site-week (`SeasonWeekMix`): task, robot and person minutes, robot and person tasks, robots needed, people from tasks, backup crew (robot minutes × ratio, in shifts), labor cost (people minutes at the site's hourly rate — the average pay rate of its last eight weeks of shifts, else the rate card, else $15), robot cost (policy cost per task), total. The plan's totals carry labor, robot, robots needed and backup; the CSV has the seven columns; the planner page has a task-demand editor per site (one list applied to every week) and the mix columns in the week table with the peak's mix in words.

## Acceptance

- *Control room live* — `src/__tests__/routes/controlRoom.test.ts`: a lead and an associate on the floor, one late, a shift in an hour unconfirmed, two robots on shift (one working with battery 67, one in error), a stalled task and a queued high-risk task, a zone; the read shows all of it and the span (2 robots, 1 lead, 4 per lead). Tightening the policy to one per lead flips the span to exceeded; a third robot's shift still starts, with the warning; an emergency stop lands in the exceptions. An associate gets 403.
- *Planner within 10 percent* — `src/__tests__/routes/hybridPlanner.test.ts`: a past week at the pilot site with four people at $15 and two robots placed; 180 done tasks (100 floor-care by robots at $3, 40 food-service by robots at $4, 40 stocking by people at 45 minutes). The plan is handed that week's work as task demand. Capacity at 50% utilisation is 3,360 robot minutes, so the planner keeps 8 of the 100 floor-care tasks with people: proposed $946.00 against actual $910.00, a 4.0% difference — within 10 percent, with a backup crew of 2 shifts.
- *Pure* — `src/__tests__/lib/hybridMix.test.ts`: capacity caps, high-risk gating both ways, no robots, the span's four cases. Run locally: 4 pass.
- *Web* — `src/__tests__/pages/controlRoom/ControlRoomPage.test.tsx`: live, loading, failed. Run locally: 3 pass.

## Decisions

1. The control room reads, it does not write: every action calls the record's own route, so the log and the audit trail are the same as from the record page.
2. People have no position. The map shows robots and zones; people sit in a rail. A punch-based position would be a lie.
3. The span counts robots with a shift covering the instant and leads clocked in now. A lead on shift but not punched in is not on the floor.
4. Task demand is one list applied to every week of the season. A week-by-week list is the next step when a site's work varies by week.
5. The mix prices people at the site's recent average pay rate, not per task type; the planner is a cost picture, payroll is the truth.
6. Robots and agents are the organization's: the control room shows every agent of the tenant (they are not placed at a site); robots are those placed at the site or on shift there.

## Open questions for the owner

- Which roles are crew leads for the span? Today: Shift supervisor, Floor supervisor, Workforce manager, Ops manager, plus any person certified for supervision.
- Should an offline robot on shift page the crew lead (a notification), or is the control room's exception enough?
- The planner's PDF does not yet carry the mix columns (the CSV does).
- Robot cost per task is the policy's figure; when 3-1's lease and maintenance costs arrive, the mix should read a per-robot cost instead.
