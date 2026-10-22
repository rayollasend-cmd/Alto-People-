import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { GeoPoint } from './geocode.js';
import { DWELL_S, driveSeconds, haversineM, homePoint, storePoint } from './transportLive.js';
import { actsAsAny } from './roleScope.js';
import { legDurations, optimizeOrder, routingAvailable } from './mapboxRouting.js';
import { credentialsEnforced, dayBounds, driverCredentialStatus, driverShiftsBetween, driverUsersByAssociate, runBusyWindow } from './transportDrivers.js';

/**
 * Dispatch, planned — the command center's click-saver.
 *
 *   orderAndTime  one van's pickups in the shortest order (farthest from
 *                 the store first, then always the nearest next), each
 *                 pickup time worked back from the earliest arrive-by —
 *                 the same drive-time estimate the live map uses. Riders
 *                 at the same stop share a pickup time.
 *   planDay       every booking still waiting on a van that day, grouped by
 *                 way / store / half hour (the board's groups). A run that
 *                 already exists for that store, way and slot with seats
 *                 free is TOPPED UP first (transport walk 3); only then is
 *                 a new van opened — the free vans (largest first) with a
 *                 free driver each. Nothing is saved — the director
 *                 reviews, changes, then dispatches.
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
  windowLabel: true,
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

/**
 * The order to work the stops. To work: the farthest pickup first, then the
 * road network's shortest way to the store (the Optimization API, first and
 * last fixed) — nearest-next when routing is off or the load is bigger than
 * one call takes. From work: the store first, then the shortest way round
 * the drop-offs. Unplaced pickups ride at the end either way.
 */
async function roadOrder<T extends { point: GeoPoint | null }>(items: T[], store: GeoPoint | null, direction: 'TO_WORK' | 'FROM_WORK'): Promise<T[]> {
  const known = items.filter((x) => x.point);
  const unknown = items.filter((x) => !x.point);
  if (direction === 'FROM_WORK') {
    if (store && routingAvailable() && known.length >= 2) {
      const order = await optimizeOrder([store, ...known.map((x) => x.point!)], { fixStart: true, fixEnd: false });
      if (order) return [...order.filter((i) => i > 0).map((i) => known[i - 1]!), ...unknown];
    }
    return nearestOrder(items, store);
  }
  const far = store ? [...known].sort((a, b) => haversineM(b.point!, store) - haversineM(a.point!, store))[0] : undefined;
  if (!far) return nearestOrder(items, null);
  const rest = known.filter((x) => x !== far);
  if (store && routingAvailable() && rest.length >= 2) {
    const order = await optimizeOrder([far.point!, ...rest.map((x) => x.point!), store], { fixStart: true, fixEnd: true });
    if (order) {
      const middle = order.filter((i) => i > 0 && i <= rest.length).map((i) => rest[i - 1]!);
      return [far, ...middle, ...unknown];
    }
  }
  return [far, ...nearestOrder(rest, far.point), ...unknown];
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
    const order = (await roadOrder(withPoints, store, 'FROM_WORK')).map((x) => ({ ...x, pickupAt: departAt }));
    return { order, departAt, arriveAt: null };
  }

  // To work: start at the pickup farthest from the store, then the road
  // network's shortest way to the store — or nearest-next without it.
  const ordered = await roadOrder(withPoints, store, 'TO_WORK');

  // Work back from the store, by the road where it answers.
  const arriveAt = new Date(minute(first.targetAt.getTime() - BUFFER_MIN * 60_000));
  const placed = ordered.filter((x) => x.point);
  const legs = store && placed.length > 0 ? await legDurations([...placed.map((x) => x.point!), store]) : null;
  const legOf = new Map<Timed['ride'], number>();
  if (legs && legs.seconds.length === placed.length) placed.forEach((x, i) => legOf.set(x.ride, legs.seconds[i]!));
  const times: number[] = new Array(ordered.length);
  let t = arriveAt.getTime();
  let next: GeoPoint | null = store;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const here = ordered[i]!.point;
    if (here && next) {
      const sameStop = haversineM(here, next) < SAME_STOP_M && i < ordered.length - 1;
      const road = legOf.get(ordered[i]!.ride);
      t -= sameStop ? 0 : (road ?? driveSeconds(here, next)) * 1000 + DWELL_S * 1000;
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
  /** new: a run to create. topUp: riders added to a run that already exists (runId). */
  kind: 'new' | 'topUp';
  runId: string | null;
  direction: 'TO_WORK' | 'FROM_WORK';
  serviceDate: string;
  store: { id: string; name: string; timezone: string; point: GeoPoint | null };
  vanId: string | null;
  driverUserId: string | null;
  departAt: string;
  arriveAt: string | null;
  /** A top-up lists the run's riders too, `existing` true — the whole run, re-timed. */
  rides: Array<{ rideId: string; name: string; place: string; pickupAt: string; point: GeoPoint | null; existing?: boolean }>;
  /** Seats after this proposal: taken (existing + added) over the van's capacity. */
  seats: { taken: number; capacity: number | null; added: number };
  warnings: string[];
}

export async function planDay(date: string): Promise<{ proposals: Proposal[]; unplaced: Array<{ rideId: string; name: string; reason: string }> }> {
  const [waiting, runs, vans, drivers, enforced] = await Promise.all([
    prisma.ride.findMany({
      where: { serviceDate: date, status: 'REQUESTED', runId: null },
      orderBy: { targetAt: 'asc' },
      select: planRideSelect,
    }),
    prisma.rideRun.findMany({
      where: { serviceDate: date, status: { in: ['PLANNED', 'ACTIVE'] } },
      select: {
        id: true,
        vanId: true,
        driverUserId: true,
        direction: true,
        departAt: true,
        startedAt: true,
        endedAt: true,
        status: true,
        van: { select: { capacity: true } },
        rides: { where: { status: { in: ['SCHEDULED', 'BOARDED'] } }, select: planRideSelect },
      },
    }),
    // A van out of service (lib/transportDrivers' fleet record) is not planned.
    prisma.van.findMany({ where: { isActive: true, outOfServiceAt: null }, orderBy: [{ capacity: 'desc' }, { name: 'asc' }] }),
    prisma.user.findMany({
      where: { ...actsAsAny(['DRIVER', 'TRANSPORTATION_DIRECTOR']), status: 'ACTIVE', deletedAt: null },
      select: { id: true, role: true, additionalRoles: true, driverProfile: { select: { licenceExpiresAt: true, dotMedicalRequired: true, dotMedicalExpiresAt: true, trainingExpiresAt: true } } },
    }),
    credentialsEnforced(),
  ]);
  // Drivers first; the director only when no driver is free. A driver
  // whose licence or DOT card has lapsed is not offered at all — nor, once
  // the desk records credentials, one with no licence on file (walk 2).
  const drivesByTrade = (u: { role: string; additionalRoles?: string[] }) =>
    u.role === 'DRIVER' || (u.additionalRoles ?? []).includes('DRIVER') ? 0 : 1;
  const fit = drivers.filter((d) => (d.driverProfile ? driverCredentialStatus(d.driverProfile).ok : !enforced));
  fit.sort((a, b) => drivesByTrade(a) - drivesByTrade(b));
  // When the day schedules drivers at all, only drivers on shift when a
  // run leaves are offered for it.
  const { from: dayFrom, to: dayTo } = dayBounds(date);
  const dayShifts = await driverShiftsBetween(dayFrom, dayTo);
  const usersByAssociate = dayShifts.length > 0 ? await driverUsersByAssociate() : null;
  const onShiftAt = (at: number): Set<string> | null => {
    if (!usersByAssociate) return null;
    const on = new Set<string>();
    for (const s of dayShifts) {
      if (!s.assignedAssociateId || s.startsAt.getTime() > at || s.endsAt.getTime() <= at) continue;
      const u = usersByAssociate.get(s.assignedAssociateId);
      if (u) on.add(u.id);
    }
    return on;
  };

  const busy: Array<{ vanId: string | null; driverUserId: string | null; from: number; to: number }> = runs.map((r) => ({
    vanId: r.vanId,
    driverUserId: r.driverUserId,
    ...runBusyWindow(r),
  }));
  // Runs that haven't left, with seats free: topped up before a new van opens.
  const openRuns = runs
    .filter((r) => r.status === 'PLANNED' && r.rides.length > 0 && r.rides.length < r.van.capacity)
    .map((r) => ({ ...r, taken: r.rides.length, added: [] as PlanRide[] }));
  const slotOf = (at: Date) => Math.floor(at.getTime() / HALF_HOUR);
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
    const storeView = { id: store.id, name: store.name, timezone: store.timezone, point: storeAt };
    // Farthest pickups first, so each van load is one neighbourhood.
    const withDist = await Promise.all(
      rides.map(async (r) => {
        const p = await homePoint(r);
        return { r, d: p && storeAt ? haversineM(p, storeAt) : 0 };
      }),
    );
    let left = withDist.sort((a, b) => b.d - a.d).map((x) => x.r);
    let n = 0;
    // Transport walk 3: a run already going this way, to this store, in
    // this half hour, with seats to spare takes these riders first.
    const slot = slotOf(rides[0]!.targetAt);
    for (const run of openRuns) {
      if (left.length === 0) break;
      const free = run.van.capacity - run.taken;
      if (free <= 0 || run.direction !== rides[0]!.direction) continue;
      if (!run.rides.every((r) => r.location.id === store.id) || slotOf(run.rides[0]!.targetAt) !== slot) continue;
      const take = left.slice(0, free);
      left = left.slice(free);
      run.taken += take.length;
      run.added.push(...take);
      const timed = await orderAndTime([...run.rides, ...run.added]);
      const addedIds = new Set(run.added.map((r) => r.id));
      const noPoint = timed.order.filter((x) => !x.point).length;
      const warnings: string[] = [];
      if (noPoint) warnings.push(`${noPoint} pickup${noPoint === 1 ? ' has' : 's have'} no map location — the time is an estimate.`);
      // The run keeps its driver; if their licence is missing or lapsed, say so before it leaves.
      if (!fit.some((d) => d.id === run.driverUserId)) warnings.push("This run's driver can't drive it now (licence not on file or lapsed) — change the driver before it leaves.");
      // One proposal per run: a second group topping the same run replaces its earlier line.
      const idx = proposals.findIndex((p) => p.kind === 'topUp' && p.runId === run.id);
      const proposal: Proposal = {
        key: `topUp|${run.id}`,
        kind: 'topUp',
        runId: run.id,
        direction: run.direction,
        serviceDate: date,
        store: storeView,
        vanId: run.vanId,
        driverUserId: run.driverUserId,
        departAt: timed.departAt.toISOString(),
        arriveAt: timed.arriveAt?.toISOString() ?? null,
        rides: timed.order.map((x) => ({
          rideId: x.ride.id,
          name: name(x.ride),
          place: place(x.ride),
          pickupAt: x.pickupAt.toISOString(),
          point: x.point,
          existing: !addedIds.has(x.ride.id),
        })),
        seats: { taken: run.taken, capacity: run.van.capacity, added: run.added.length },
        warnings,
      };
      if (idx >= 0) proposals[idx] = proposal;
      else proposals.push(proposal);
    }
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
      // The van's own driver when they're free, else any free driver — on
      // shift, when the day has driver shifts.
      const shift = onShiftAt(probe.departAt.getTime());
      const eligible = shift ? fit.filter((d) => shift.has(d.id)) : fit;
      const own = van?.driverUserId ? eligible.find((d) => d.id === van.driverUserId && free(from, to, 'driverUserId', d.id)) : undefined;
      const driver = own ?? eligible.find((d) => free(from, to, 'driverUserId', d.id)) ?? null;
      busy.push({ vanId: van?.id ?? null, driverUserId: driver?.id ?? null, from, to });
      const warnings: string[] = [];
      if (!van) warnings.push('No van is free then — pick one.');
      if (!driver) warnings.push(shift ? 'No driver on shift is free then — schedule one, or pick one.' : 'No driver is free then — pick one.');
      const noPoint = timed.order.filter((x) => !x.point).length;
      if (noPoint) warnings.push(`${noPoint} pickup${noPoint === 1 ? ' has' : 's have'} no map location — the time is an estimate.`);
      proposals.push({
        key: `${gKey}|${n++}`,
        kind: 'new',
        runId: null,
        direction: load[0]!.direction,
        serviceDate: date,
        store: storeView,
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
        seats: { taken: load.length, capacity: van?.capacity ?? null, added: load.length },
        warnings,
      });
    }
  }
  proposals.sort((a, b) => a.departAt.localeCompare(b.departAt));
  return { proposals, unplaced: [] };
}
