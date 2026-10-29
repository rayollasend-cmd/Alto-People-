# Transport — rider, driver and dispatch

Rebuilt 2026-10-28 to the standard of Uber (the rider and the driver) and a Fortune-500 fleet dispatch (the director's desk). Three people, three screens:

- **The rider** (an associate, Ride tab): on a phone at the gate at 5:15 AM. One state at a time, the van on the map, "Mike is 6 min away".
- **The driver** (DRIVER role, home page): driving with one hand free. One big next action, holds for anything that can't be undone.
- **The director** (view:transport, `/transport`): six vans out. What is wrong right now, worst first, each with the one click that fixes it.

Shapes: `packages/shared/src/transportOps.ts` (new) and `apps/web/src/lib/transportApi.ts` (existing, with the additions). Web hooks for the new endpoints: `apps/web/src/lib/transportOpsApi.ts`.

## The rider (`pages/transport/rider/*`, `RideHome`)

- **Live trip** (`LiveTrip`, state from `tripState.ts`): map-first once a van is on the run. Before pickup it shows who to look for (the driver's first name, the van's colour/make/model and plate chip), where exactly to wait (the stop's note), how long the van waits (`waitMinutes`, the no-show rule: 3 minutes), the ETA in big type, and the dispatch line. After boarding it switches to the drop-off ETA. The page polls every 15 s while the van is out and in the half hour before it leaves, a minute otherwise.
- **Share my ride**: POST `/transport/me/rides/:id/share` returns a `/track/<token>` link that shows only the van and the ETA, never riders or addresses. It expires 2 hours after the run's expected end.
- **What I owe** (`OwedCard`, `ChargesLedger`, model in `charges.ts`): the balance in one line, then a ledger with one row per ride and its state in words: due on the next payday, "Taken from your pay on Nov 6" (payroll's `disbursedAt` for the run that charged it), waived (no-show fees only, see the memory rule *a ride taken is never waived*), or not charged ("The van didn't run"). Amounts are exact here. "Question a charge" opens a CHARGE_DISPUTE report.
- **Privacy**: a rider never sees the driver's phone number or another rider's address. Rider text is in en/es/tr/ht/pt/uk; the few sentences the server writes (fare words, "didn't run") come in the rider's language (`lib/transportRider.ts`).

## The driver (`pages/transport/driver/*`, `DriverHome`)

- **Drive now** (`DriveNow`, model `driveModel.ts`): the run in progress or the next one, one gold action at a time (Start → Arrived → Boarded / No-show → Complete). Run actions are ≥56px. Complete run is a 1.2 s hold (`HoldButton`) and a confirm; No-show opens only when the stop's wait has run out (counted down on screen) and confirms with the fee. Taps queue offline (`lib/offlineTransport`) and replay; the offline banner leaves them to the driver's own line.
- **Pre-trip once per van per day**: a passed check on any run that day covers the van (`preTripDone`, `fromOtherRun`).
- **Conflicts**: overlapping runs for the same driver or van are shown with a call-dispatch button.
- **Later today / the week** (`LaterToday`, `WeekStrip`): the rest of the day, plus yesterday's and today's runs that didn't run.
- **Pay** (`DriveHeader` pill → `EarningsSheet`, model `driverPay.ts`): drivers are paid by the hour on the clock, not per ride, and the sheet says so. It shows this shift so far (it ticks while on the clock), today, the week (Saturday→Friday) and its pace, hours worked and driving, the rate (marked when it is the company default), overtime as the earnings engine counts it, take-home after taxes and deductions (the tax engine; a basis of `NO_W4` or `NO_WITHHOLDING` is said), and the payday. All of it comes from GET `/transport/driver/today` (`earnings`, `nextPayday`); nothing is estimated in the browser beyond the live tick.
- `/transport` sends a driver who can't view transport back to their home (`TransportRoute` in App.tsx), so there's no dead end.

## The director (`pages/transport/TransportHome`, `live/*`, `desk/*`)

Tabs: **Today · Live · Rides · Issues**, with Setup (Vans, Drivers, Stops, Settings, Charges) behind its own menu.

- **Today**: the day in one line (`DayLine`), the exceptions queue (compact), the four KPIs, and **readiness** for tomorrow (or the future day being viewed) (`ReadinessStrip`, GET `/transport/readiness`): riders placed, seats, drivers (double-booked, hours, rest), credentials, vans ready, vans double-booked, each with where to fix it.
- **Live** (`LiveOpsTab`, GET `/transport/ops`, polls every 20 s): the fleet map (`components/transport/LiveMap`, MapLibre, its own chunk), the fleet list (on the road · no signal · planned · idle · out of service) and the exceptions queue.
- **Exceptions** (worst first, then oldest; stable ids so the list doesn't jump): SOS (acknowledge in place), late 5+ min (high at 15), stalled, not started 10 min past departure, driver or van double-booked, riders with no van, failed pre-trip, out-of-service van with a run, lapsed credential, no-show (an FYI for 2 hours), open report, didn't run.
- **Moving a rider** (`desk/moves.ts`, `useRideMoves`, drag on the board or `MoveMenu`): POST `/transport/rides/:id/move` onto another run of the same day and direction, or off every run. Only before the run leaves. A full van after the move is a warning, not a refusal. Pickups are re-timed the planner's way; the riders whose pickup changed are told.

### The KPIs (last 7 days against the 7 before, eight weekly points)

| KPI | Definition | Good / watch |
|---|---|---|
| On-time pickups | pickups reached within 5 min of plan ÷ pickups with both times | ≥95% / ≥85% |
| Seats filled | riders carried ÷ seats offered, on finished runs | ≥60% / ≥40% |
| Cost per ride | driver hours × each driver's rate + fuel and upkeep from the service log, ÷ rides completed (`lib/transportCosts`) | up >10% watch, >25% bad |
| No-shows | no-shows ÷ (completed + no-shows) | ≤3% / ≤8% |

## The "didn't run" sweep (`lib/transportNotRun.ts`, every 15 min)

A run only leaves when its driver taps Start. A PLANNED run that never started is closed 3 hours past its departure, never sooner (a run's date is its site's, so a date rule would close a late western run before it left): CANCELLED, `autoClosedAt`, "Didn't run — the van never started" (`isNotRun` tells it from a run the desk cancelled). Its waiting riders are cancelled with "The van didn't run" and **never charged**. The desk hears once per run; each rider once, in their language.

## Tests

API: `transportOpsBoard`, `transportRiderMove`, `transportNotRun` plus every `transport*.test.ts`. Web: `RiderLive`, `driveMode`, `driverPay`, `LiveOps`, `fleetModel`, `TransportDispatchDesk` plus the existing transport page tests. The axe sweep and the persona walks cover the rider, the driver and the director (`e2e/walkPersonas.ts`).
