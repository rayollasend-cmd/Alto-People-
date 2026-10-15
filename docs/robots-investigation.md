# Brief 3-1 — Robot registry and fleet connectors

Built 2026-10-15 on the owner's instruction to complete Phase 3 without stopping. The manufacturer in the pilot is unconfirmed, so the fleet layer is an interface with a deterministic simulated fleet behind it and adapter skeletons for the two candidates; everything else in the brief is real.

## What existed

- A robot was already a Worker of type ROBOT (Brief 1D-1): owner required, status, capabilities from the shared catalog (stocking, floor care, shelf scanning, food service, room delivery, unloading), placements through WorkerAssignment, `Shift.workerId`.
- The Workforce roster (`/workers`) listed robots behind the robotics module and had no record to open for one.
- The OSHA injury log (`OshaIncident`) and the safety desk already existed; incident.loop chases open incidents.

## What this brief adds

| Piece | Where |
|---|---|
| Robot profile: manufacturer, model, serial, firmware, owned or leased, certifications, connector provider and external id | `RobotProfile` (one per ROBOT worker, created on first read) |
| Fleet connector interface, the simulated fleet, Bear Robotics and Pudu adapter skeletons | `apps/api/src/lib/fleet/` |
| Status time series, one reading a minute per tenant with robotics on, 90-day retention | `RobotStatusSample`, `sampleRobots`, the job in `index.ts` |
| Site commissioning: map, charging stations, named safety lead, sign-off (only the lead signs) | `RobotCommissioning` |
| Safety zones per site (rectangle or polygon) with a guest-occupied switch | `SiteSafetyZone`, `pointInZone`, `blockingZone` |
| Pre-shift checklist templates (tenant-wide or per site) and completion runs | `RobotChecklistTemplate`, `RobotChecklistRun` |
| The shift gate: checklist passed within 12 hours, commissioning signed off, not inside an occupied zone | `startRobotShift` (`POST /robots/:id/shifts/:shiftId/start`) |
| Emergency stop and resume, on the fleet and on the record (worker SUSPENDED while stopped) | `emergencyStop`, `resumeRobot`, `RobotEvent` |
| Maintenance history | `RobotMaintenance` |
| Incidents and near misses with the hour's samples, events and the people on shift copied in as evidence, kept five years; an injury or damage at a client site also opens an `OshaIncident` | `RobotIncident`, `reportIncident` |
| Robots page (`/robots`) and the robot record (`/robots/:id`: Live status, Profile, Commissioning, Checklists, Incidents, Events, Maintenance); Safety zones per site (`/robots/sites/:id/zones`) | `apps/web/src/pages/robots/` |

Routes are under `/robots` (view:org to read; manage:org for the fleet's facts; manage:scheduling for what a crew lead does on the floor). Shapes in `packages/shared/src/robots.ts`. Migration `20261204100000_robots`.

## Decisions taken for the owner

1. **Connector by environment.** `FLEET_PROVIDER=SIMULATED|BEAR|PUDU`, `FLEET_API_BASE`, `FLEET_API_KEY`. A robot whose profile names a provider other than the environment's is read through the simulated fleet, so a demo never calls a vendor. The vendor request and response shapes are isolated in `bear.ts` and `pudu.ts` with a "confirm against the vendor API" note each; they are a reading of a fleet REST API, not a published contract.
2. **Poll, not push.** The minute poll is the source of truth; a connector may also `subscribe`, and a pushed reading goes through the same `storeSample`.
3. **Zones as map coordinates.** Zones and the robot's position are in the commissioning map's own units (the connector reports site-local x and y). A robot with no known position is not blocked by a zone; the checklist and the commissioning still gate it.
4. **Near misses are evidence, not OSHA rows.** Only an injury or property damage at a client site opens an OshaIncident (severity from the report, first aid by default, recordable only above first aid). A hotel (client-less site) keeps the robot incident with its evidence and no OSHA row, since that log is per client.
5. **Stop = suspend.** An emergency stop suspends the worker (nothing can schedule it) and asks the fleet to halt; resume reactivates. The log is `RobotEvent` and the audit trail.
6. **Simulated fleet in the demo.** The demo seed turns the robotics module on for the Alto tenant and commissions two Bear Servi robots at Front Beach 218 with a checklist, two zones, a day of samples and one near miss, so the design walk shows the registry populated.

## What the owner must confirm

- The pilot manufacturer and a sandbox credential, to replace the adapter skeleton's guesses with the vendor's contract.
- The map units each site will use for zones and charging stations (the commissioning map's own pixels, or metres).
- Who the safety lead is per site (the sign-off is theirs alone).
- Whether a robot near miss should also reach the compliance desk as an action (today only injuries and damage at client sites do, through the OSHA log).

## Not verified here

No Postgres on the build machine: the API test (`src/__tests__/routes/robots.test.ts`) and the migration run in CI. The design walk proves the pages with the demo seed.
