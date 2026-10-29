import { fmtTimeTz } from '@/lib/format';
import type { Ride, RideRun, TransportBoard } from '@/lib/transportApi';
import { firstName } from './rideWords';

/**
 * Moving a rider between runs (drag to dispatch, or the Move to… menu): which
 * moves the desk offers, why a run can't take someone, and the board as it
 * will look once the server agrees — so the move shows at once and rolls back
 * if it doesn't. The server (POST /transport/rides/:id/move) is the authority;
 * these checks only say no early and in words.
 */

/** A rider picked up off a run's list (fromRunId) or off "Needs a van" (null). */
export interface MovingRide {
  ride: Ride;
  fromRunId: string | null;
}

export type MoveCheck =
  | { ok: true; seatsAfter: { taken: number; capacity: number } | null; caution: string | null }
  | { ok: false; reason: string };

/** The drop target for "back to Needs a van". */
export const NEEDS_VAN = 'needs-van';

const way = (d: Ride['direction']) => (d === 'TO_WORK' ? 'to work' : 'home from work');

/**
 * A rider the desk can move: still waiting for a van, or on a run that hasn't
 * left — and their time still ahead (a past ride stays where it happened).
 */
export function canMoveRide(ride: Ride, fromRun: RideRun | null, now = Date.now()): boolean {
  if (Date.parse(ride.targetAt) <= now) return false;
  if (ride.status === 'REQUESTED') return !fromRun;
  if (ride.status !== 'SCHEDULED' || !fromRun) return false;
  return fromRun.status === 'PLANNED' && !fromRun.notRun;
}

/** Can this run take the rider? With the seats it would have after, or why not. */
export function checkMoveToRun(m: MovingRide, run: RideRun, tz?: string): MoveCheck {
  const who = firstName(m.ride.rider.name);
  const van = run.van.name;
  if (run.id === m.fromRunId) return { ok: false, reason: `${who} is already on ${van}.` };
  if (run.notRun) return { ok: false, reason: `${van} didn’t run.` };
  if (run.status === 'CANCELLED') return { ok: false, reason: `${van}’s run was called off.` };
  if (run.status === 'ACTIVE') return { ok: false, reason: `${van} is already on the road.` };
  if (run.status === 'COMPLETED') return { ok: false, reason: `${van}’s run is finished.` };
  if (run.serviceDate !== m.ride.serviceDate) return { ok: false, reason: `${van} runs on another day.` };
  if (run.direction !== m.ride.direction) {
    return { ok: false, reason: `${van} goes ${way(run.direction)} — ${who}’s ride is ${way(m.ride.direction)}.` };
  }
  const taken = run.seats.taken + 1;
  if (taken > run.seats.capacity) {
    return { ok: false, reason: `${van} is full — ${run.seats.taken} of ${run.seats.capacity} seats taken.` };
  }
  // Not a refusal — the desk may know better — but never a surprise.
  const depart = Date.parse(run.departAt);
  const target = Date.parse(m.ride.targetAt);
  let caution: string | null = null;
  if (m.ride.direction === 'TO_WORK' && depart >= target) {
    caution = `Leaves at ${fmtTimeTz(run.departAt, tz)}, after ${who}’s ${fmtTimeTz(m.ride.targetAt, tz)} arrive-by.`;
  } else if (m.ride.direction === 'FROM_WORK' && Math.abs(depart - target) > 90 * 60_000) {
    caution = `Leaves at ${fmtTimeTz(run.departAt, tz)} — ${who} is done at ${fmtTimeTz(m.ride.targetAt, tz)}.`;
  }
  return { ok: true, seatsAfter: { taken, capacity: run.seats.capacity }, caution };
}

/** Off every run, back to waiting for a van. */
export function checkMoveToNeedsVan(m: MovingRide): MoveCheck {
  if (!m.fromRunId) return { ok: false, reason: `${firstName(m.ride.rider.name)} is already waiting for a van.` };
  return { ok: true, seatsAfter: null, caution: null };
}

export function checkMove(m: MovingRide, toRunId: string | null, board: Pick<TransportBoard, 'runs'>, tz?: string): MoveCheck {
  if (toRunId === null) return checkMoveToNeedsVan(m);
  const run = board.runs.find((r) => r.id === toRunId);
  if (!run) return { ok: false, reason: 'That run is no longer on the board.' };
  return checkMoveToRun(m, run, tz);
}

/** "4 of 12 seats" */
export const seatsText = (s: { taken: number; capacity: number }) => `${s.taken} of ${s.capacity} seats`;

/**
 * The board once the move lands: off the old run (a seat freed), onto the new
 * one at the end of its pickups (a seat taken), its row in the day's rides
 * re-pointed. Pure — the caller keeps the old board to roll back to.
 */
export function applyMove(board: TransportBoard, rideId: string, toRunId: string | null): TransportBoard {
  const ride = board.rides.find((r) => r.id === rideId) ?? board.runs.flatMap((r) => r.rides).find((r) => r.id === rideId);
  if (!ride) return board;
  const to = toRunId ? board.runs.find((r) => r.id === toRunId) ?? null : null;
  if (toRunId && !to) return board;
  const moved: Ride = {
    ...ride,
    status: to ? 'SCHEDULED' : 'REQUESTED',
    pickupOrder: to ? Math.max(0, ...to.rides.map((r) => r.pickupOrder ?? 0)) + 1 : null,
    pickupAt: to ? ride.pickupAt : null,
    run: to
      ? { id: to.id, status: to.status, departAt: to.departAt, van: { id: to.van.id, name: to.van.name, plate: to.van.plate }, driver: { userId: to.driver.userId, name: to.driver.name, associateId: null } }
      : null,
  };
  const wasWaiting = ride.status === 'REQUESTED';
  return {
    ...board,
    kpis: { ...board.kpis, needsVan: Math.max(0, board.kpis.needsVan + (to ? (wasWaiting ? -1 : 0) : wasWaiting ? 0 : 1)) },
    rides: board.rides.map((r) => (r.id === rideId ? moved : r)),
    runs: board.runs.map((run) => {
      const had = run.rides.some((r) => r.id === rideId);
      if (had && run.id !== toRunId) {
        return { ...run, rides: run.rides.filter((r) => r.id !== rideId), seats: { ...run.seats, taken: Math.max(0, run.seats.taken - 1) } };
      }
      if (run.id === toRunId && !had) {
        return { ...run, rides: [...run.rides, moved], seats: { ...run.seats, taken: run.seats.taken + 1 } };
      }
      return run;
    }),
  };
}
