import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { GeoPoint } from './geocode.js';
import { DWELL_S, driveSeconds, haversineM, homePoint, storePoint } from './transportLive.js';

/**
 * Dispatch, planned — the command center's click-saver.
 *
 *   orderAndTime  one van's pickups in the shortest order (farthest from
 *                 the store first, then always the nearest next), each
 *                 pickup time worked back from the earliest arrive-by —
 *                 the same drive-time estimate the live map uses. Riders
 *                 at the same stop share a pickup time.
 *   planDay       every booking still waiting on a van that day, grouped by
 *                 way / store / half hour (the board's groups), filled into
 *                 the free vans (largest first) with a free driver each.
 *                 Nothing is saved — the director reviews, changes, then
 *                 dispatches.
 */

/** At the store this long before the earliest arrive-by. */
const BUFFER_MIN = 5;
/** Leave the lot this long before the first pickup. */
const LEAD_MIN = 10;
/** Two riders this close are one stop. */
const SAME_STOP_M = 60;
/** How long a van and driver count as busy after a run leaves. */
const RUN_SPAN_MS = 2 * 3_600_000;
const HALF_HOUR = 1_800_000;

export const planRideSelect = {
  id: true,
  direction: true,
  status: true,
  runId: true,
  targetAt: true,
  serviceDate: true,
  address: true,
  lat: true,
  lng: true,
  stop: { select: { id: true, name: true, address: true, lat: true, lng: true } },
  associate: { select: { firstName: true, lastName: true } },
  location: {
    select: {
      id: true,
      name: true,
      timezone: true,
      addressLine1: true,
      city: true,
      state: true,
      zip: true,
      latitude: true,
      longitude: true,
    },
  },
} satisfies Prisma.RideSelect;

export type PlanRide = Prisma.RideGetPayload<{ select: typeof planRideSelect }>;

const minute = (ms: number) => Math.floor(ms / 60_000) * 60_000;
const name = (r: PlanRide) => `${r.associate.firstName} ${r.associate.lastName}`;
const place = (r: PlanRide) => r.stop?.name ?? r.address ?? '';

export interface Timed {
  ride: PlanRide;
  point: GeoPoint | null;
  pickupAt: Date;
}

/** Nearest-neighbour order from `start`: always the closest next point. */
function nearestOrder<T extends { point: GeoPoint | null }>(items: T[], start: GeoPoint | null): T[] {
  const known = items.filter((x) => x.point);
  const unknown = items.filter((x) => !x.point);
  const out: T[] = [];
  let at = start;
  while (known.length > 0) {
    let best = 0;
    if (at) {
      let bestD = Infinity;
      known.forEach((x, i) => {
        const d = haversineM(at!, x.point!);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
    }
    const [next] = known.splice(best, 1);
    out.push(next!);
    at = next!.point;
  }
  return [...out, ...unknown];
}

export async function orderAndTime(
  rides: PlanRide[],
): Promise<{ order: Timed[]; departAt: Date; arriveAt: Date | null }> {
  const direction = rides[0]!.direction;
  const withPoints = await Promise.all(rides.map(async (ride) => ({ ride, point: await homePoint(ride) })));
  // The destination (to work) / origin (home): the store with the earliest time.
  const first = [...rides].sort((a, b) => a.targetAt.getTime() - b.targetAt.getTime())[0]!;
  const store = await storePoint(first.location);

  if (direction === 'FROM_WORK') {
    // Everyone boards at the store once the last of them is off.
    const departAt = new Date(minute(Math.max(...rides.map((r) => r.targetAt.getTime()))));
    const order = nearestOrder(withPoints, store).map((x) => ({ ...x, pickupAt: departAt }));
    return { order, departAt, arriveAt: null };
  }

  // To work: start at the pickup farthest from the store, then nearest next.
  const far = store
    ? [...withPoints].filter((x) => x.point).sort((a, b) => haversineM(b.point!, store) - haversineM(a.point!, store))[0]
    : undefined;
  const ordered = far ? [far, ...nearestOrder(withPoints.filter((x) => x !== far), far.point)] : nearestOrder(withPoints, null);

  // Work back from the store.
  const arriveAt = new Date(minute(first.targetAt.getTime() - BUFFER_MIN * 60_000));
  const times: number[] = new Array(ordered.length);
  let t = arriveAt.getTime();
  let next: GeoPoint | null = store;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const here = ordered[i]!.point;
    if (here && next) {
      const sameStop = haversineM(here, next) < SAME_STOP_M && i < ordered.length - 1;
      t -= sameStop ? 0 : driveSeconds(here, next) * 1000 + DWELL_S * 1000;
    } else {
      t -= 5 * 60_000; // no map point: a rough five minutes
    }
    times[i] = minute(t);
    if (here) next = here;
  }
  const order = ordered.map((x, i) => ({ ...x, pickupAt: new Date(times[i]!) }));
  const departAt = new Date(minute(order[0]!.pickupAt.getTime() - LEAD_MIN * 60_000));
  return { order, departAt, arriveAt };
}

export interface Proposal {
  key: string;
  direction: 'TO_WORK' | 'FROM_WORK';
  serviceDate: string;
  store: { id: string; name: string; timezone: string };
  vanId: string | null;
  driverUserId: string | null;
  departAt: string;
  arriveAt: string | null;
  rides: Array<{ rideId: string; name: string; place: string; pickupAt: string; point: GeoPoint | null }>;
  warnings: string[];
}

export async function planDay(date: string): Promise<{ proposals: Proposal[]; unplaced: Array<{ rideId: string; name: string; reason: string }> }> {
  const [waiting, runs, vans, drivers] = await Promise.all([
    prisma.ride.findMany({
      where: { serviceDate: date, status: 'REQUESTED', runId: null },
      orderBy: { targetAt: 'asc' },
      select: planRideSelect,
    }),
    prisma.rideRun.findMany({
      where: { serviceDate: date, status: { in: ['PLANNED', 'ACTIVE'] } },
      select: { vanId: true, driverUserId: true, departAt: true },
    }),
    prisma.van.findMany({ where: { isActive: true }, orderBy: [{ capacity: 'desc' }, { name: 'asc' }] }),
    prisma.user.findMany({
      where: { role: { in: ['DRIVER', 'TRANSPORTATION_DIRECTOR'] }, status: 'ACTIVE', deletedAt: null },
      select: { id: true, role: true },
    }),
  ]);
  // Drivers first; the director only when no driver is free.
  drivers.sort((a, b) => (a.role === 'DRIVER' ? 0 : 1) - (b.role === 'DRIVER' ? 0 : 1));

  const busy: Array<{ vanId: string | null; driverUserId: string | null; from: number; to: number }> = runs.map((r) => ({
    vanId: r.vanId,
    driverUserId: r.driverUserId,
    from: r.departAt.getTime() - 15 * 60_000,
    to: r.departAt.getTime() + RUN_SPAN_MS,
  }));
  const free = (from: number, to: number, key: 'vanId' | 'driverUserId', id: string) =>
    !busy.some((b) => b[key] === id && b.from < to && b.to > from);

  // The board's groups: way, store, half hour.
  const groups = new Map<string, PlanRide[]>();
  for (const r of waiting) {
    const key = `${r.direction}|${r.location.id}|${Math.floor(r.targetAt.getTime() / HALF_HOUR)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const proposals: Proposal[] = [];
  for (const [gKey, rides] of groups) {
    const store = rides[0]!.location;
    const storeAt = await storePoint(store);
    // Farthest pickups first, so each van load is one neighbourhood.
    const withDist = await Promise.all(
      rides.map(async (r) => {
        const p = await homePoint(r);
        return { r, d: p && storeAt ? haversineM(p, storeAt) : 0 };
      }),
    );
    let left = withDist.sort((a, b) => b.d - a.d).map((x) => x.r);
    let n = 0;
    while (left.length > 0) {
      // Time the whole remaining group first to know when this van leaves.
      const probe = await orderAndTime(left);
      const from = probe.departAt.getTime() - 15 * 60_000;
      const to = probe.departAt.getTime() + RUN_SPAN_MS;
      const van = vans.find((v) => free(from, to, 'vanId', v.id)) ?? null;
      const cap = van?.capacity ?? vans[0]?.capacity ?? left.length;
      const load = left.slice(0, cap);
      left = left.slice(cap);
      const timed = await orderAndTime(load);
      // The van's own driver when they're free, else any free driver.
      const own = van?.driverUserId ? drivers.find((d) => d.id === van.driverUserId && free(from, to, 'driverUserId', d.id)) : undefined;
      const driver = own ?? drivers.find((d) => free(from, to, 'driverUserId', d.id)) ?? null;
      busy.push({ vanId: van?.id ?? null, driverUserId: driver?.id ?? null, from, to });
      const warnings: string[] = [];
      if (!van) warnings.push('No van is free then — pick one.');
      if (!driver) warnings.push('No driver is free then — pick one.');
      const noPoint = timed.order.filter((x) => !x.point).length;
      if (noPoint) warnings.push(`${noPoint} pickup${noPoint === 1 ? ' has' : 's have'} no map location — the time is an estimate.`);
      proposals.push({
        key: `${gKey}|${n++}`,
        direction: load[0]!.direction,
        serviceDate: date,
        store: { id: store.id, name: store.name, timezone: store.timezone },
        vanId: van?.id ?? null,
        driverUserId: driver?.id ?? null,
        departAt: timed.departAt.toISOString(),
        arriveAt: timed.arriveAt?.toISOString() ?? null,
        rides: timed.order.map((x) => ({
          rideId: x.ride.id,
          name: name(x.ride),
          place: place(x.ride),
          pickupAt: x.pickupAt.toISOString(),
          point: x.point,
        })),
        warnings,
      });
    }
  }
  proposals.sort((a, b) => a.departAt.localeCompare(b.departAt));
  return { proposals, unplaced: [] };
}
