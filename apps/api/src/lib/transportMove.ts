import type { Prisma } from '@prisma/client';
import type { MoveRideResult } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import type { GeoPoint } from './geocode.js';
import { haversineM, homePoint, storePoint } from './transportLive.js';
import { planRideSelect, timeToWork, type PlanRide } from './transportPlan.js';

/**
 * Moving one rider (transport upgrade 2026-10-28) — POST
 * /transport/rides/:id/move: onto another run of the same day and way, or
 * off every run back to "needs a van".
 *
 *   rules     the ride is waiting (REQUESTED) or on a run that hasn't left
 *             (SCHEDULED on a PLANNED run); the destination hasn't left;
 *             same service day, same way; never past the van's seats (a
 *             full van after the move is said, not refused)
 *   order     where the desk dropped them (`pickupOrder`), else the cheapest
 *             place in the run's existing order — the other riders keep
 *             theirs (a pickup slotted in, not a run re-planned)
 *   times     to work: every pickup re-timed the planner's way, worked back
 *             from the earliest arrive-by (lib/transportPlan timeToWork);
 *             home: everyone boards at the place when the van leaves
 *
 * This file decides; the route writes, audits and tells the riders whose
 * pickup changed.
 */

export interface MovePlan {
  rideId: string;
  associateId: string;
  fromRunId: string | null;
  toRunId: string | null;
  /** The destination's riders in their new order, with each pickup time (the moved rider among them). */
  order: Array<{ rideId: string; pickupAt: Date; was: Date | null }>;
  /** The source run's riders left behind, renumbered (times kept). */
  leftBehind: Array<{ rideId: string; pickupOrder: number }>;
  seats: MoveRideResult['seats'];
  warnings: string[];
  /** For the notices. */
  ride: { targetAt: Date; timezone: string; riderName: string };
  fromVan: string | null;
  toVan: string | null;
  /** The ride was waiting for a van (it is accepted now). */
  wasWaiting: boolean;
}

const fmtTime = (d: Date, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);

const runSelect = {
  id: true,
  status: true,
  direction: true,
  serviceDate: true,
  departAt: true,
  van: { select: { name: true, capacity: true } },
  rides: { where: { status: { in: ['SCHEDULED', 'BOARDED'] } }, orderBy: [{ pickupOrder: 'asc' }, { targetAt: 'asc' }], select: { ...planRideSelect, pickupOrder: true, pickupAt: true } },
} satisfies Prisma.RideRunSelect;

/** The cheapest place to slot `q` into a route: to work [pickups…, place]; home [place, drop-offs…]. */
export function cheapestSlot(points: Array<GeoPoint | null>, q: GeoPoint | null, end: GeoPoint | null, direction: 'TO_WORK' | 'FROM_WORK'): number {
  if (!q) return points.length;
  const d = (a: GeoPoint | null, b: GeoPoint | null) => (a && b ? haversineM(a, b) : 0);
  let best = points.length;
  let bestCost = Infinity;
  for (let i = 0; i <= points.length; i++) {
    const prev = i > 0 ? points[i - 1]! : direction === 'FROM_WORK' ? end : null;
    const next = i < points.length ? points[i]! : direction === 'TO_WORK' ? end : null;
    const cost = (prev ? d(prev, q) : 0) + (next ? d(q, next) : 0) - (prev && next ? d(prev, next) : 0);
    if (cost < bestCost - 1e-6) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}

export async function planMove(rideId: string, input: { toRunId: string | null; pickupOrder?: number }): Promise<MovePlan> {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { ...planRideSelect, associateId: true, pickupAt: true, run: { select: runSelect } },
  });
  if (!ride) throw new HttpError(404, 'not_found', 'Ride not found.');
  const name = `${ride.associate.firstName} ${ride.associate.lastName}`;
  if (ride.status !== 'REQUESTED' && ride.status !== 'SCHEDULED') {
    throw new HttpError(409, 'ride_closed', `${name}'s ride is ${ride.status === 'BOARDED' ? 'already on board' : 'over'} — only a ride still waiting can move.`);
  }
  const from = ride.runId ? ride.run : null;
  if (from && from.status !== 'PLANNED') {
    throw new HttpError(409, 'run_left', `${from.van.name}'s run has already left — ${name} can't be moved off it now.`);
  }
  const base = {
    rideId,
    associateId: ride.associateId,
    fromRunId: from?.id ?? null,
    ride: { targetAt: ride.targetAt, timezone: ride.location.timezone, riderName: name },
    fromVan: from?.van.name ?? null,
    wasWaiting: !from,
  };
  const leftBehindOf = () =>
    from
      ? from.rides
          .filter((r) => r.id !== rideId && r.status === 'SCHEDULED')
          .map((r, i) => ({ rideId: r.id, pickupOrder: i + 1 }))
      : [];

  // Off every run: back to "needs a van".
  if (input.toRunId === null) {
    return { ...base, toRunId: null, order: [], leftBehind: leftBehindOf(), seats: null, warnings: [], toVan: null };
  }

  const to = input.toRunId === from?.id ? from : await prisma.rideRun.findUnique({ where: { id: input.toRunId }, select: runSelect });
  if (!to) throw new HttpError(404, 'run_not_found', 'That run no longer exists.');
  if (to.status !== 'PLANNED') throw new HttpError(409, 'run_left', `${to.van.name}'s run has already ${to.status === 'CANCELLED' ? 'been called off' : 'left'} — pick a run that hasn't.`);
  if (to.serviceDate !== ride.serviceDate) throw new HttpError(409, 'ride_mismatch', `${name} rides on another day than ${to.van.name}'s run.`);
  if (to.direction !== ride.direction) {
    throw new HttpError(409, 'ride_mismatch', `${name} is going ${ride.direction === 'TO_WORK' ? 'to work' : 'home'}; ${to.van.name}'s run goes ${to.direction === 'TO_WORK' ? 'to work' : 'home'}.`);
  }
  const others = to.rides.filter((r) => r.id !== rideId);
  const taken = others.length + 1;
  if (taken > to.van.capacity) {
    throw new HttpError(409, 'over_capacity', `${to.van.name} seats ${to.van.capacity} and already has ${others.length} riders — there's no seat for ${name}.`);
  }
  const warnings: string[] = [];
  if (taken === to.van.capacity) warnings.push(`${to.van.name} is now at ${taken} of ${to.van.capacity} seats.`);

  // The order: riders already on board keep their place; the waiting ones
  // keep theirs too, with the moved rider slotted where it costs least
  // (or where the desk dropped them).
  const waiting = others.filter((r) => r.status === 'SCHEDULED');
  const aboard = others.filter((r) => r.status === 'BOARDED');
  const all: PlanRide[] = [...waiting, ride];
  const points = await Promise.all(all.map((r) => homePoint(r)));
  const firstTarget = [...all].sort((a, b) => a.targetAt.getTime() - b.targetAt.getTime())[0]!;
  const store = await storePoint(firstTarget.location);
  const existing = waiting.map((r, i) => ({ ride: r as PlanRide, point: points[i] ?? null }));
  const me = { ride: ride as PlanRide, point: points[points.length - 1] ?? null };
  const slot =
    input.pickupOrder !== undefined
      ? Math.max(0, Math.min(existing.length, input.pickupOrder - 1 - aboard.length))
      : cheapestSlot(existing.map((x) => x.point), me.point, store, to.direction);
  const ordered = [...existing.slice(0, slot), me, ...existing.slice(slot)];

  const wasOf = new Map<string, Date | null>([...others.map((r) => [r.id, r.pickupAt] as const), [ride.id, ride.pickupAt]]);
  let timed: Array<{ rideId: string; pickupAt: Date }>;
  if (to.direction === 'TO_WORK') {
    const t = await timeToWork(ordered, store, firstTarget.targetAt);
    timed = t.order.map((x) => ({ rideId: x.ride.id, pickupAt: x.pickupAt }));
    if (t.departAt.getTime() < to.departAt.getTime()) {
      warnings.push(`The first pickup is now ${fmtTime(t.order[0]!.pickupAt, ride.location.timezone)} — ${to.van.name} leaves at ${fmtTime(to.departAt, ride.location.timezone)}; move its departure earlier.`);
    }
  } else {
    // Home: everyone boards at the place when the van leaves.
    timed = ordered.map((x) => ({ rideId: x.ride.id, pickupAt: to.departAt }));
    if (ride.targetAt.getTime() > to.departAt.getTime()) {
      warnings.push(`${name} is picked up at ${fmtTime(ride.targetAt, ride.location.timezone)}, after ${to.van.name} leaves at ${fmtTime(to.departAt, ride.location.timezone)}.`);
    }
  }
  return {
    ...base,
    toRunId: to.id,
    // Riders already on board keep their numbers ahead of the waiting ones.
    order: timed.map((x) => ({ ...x, was: wasOf.get(x.rideId) ?? null })),
    leftBehind: from && from.id !== to.id ? leftBehindOf() : [],
    seats: { taken, capacity: to.van.capacity },
    warnings,
    toVan: to.van.name,
  };
}
