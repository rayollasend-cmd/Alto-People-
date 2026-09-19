import type { Prisma, RideDirection } from '@prisma/client';
import { prisma } from '../db.js';
import { notifyAssociate, notifyUser, trackNotificationWork } from './notify.js';
import { emitLiveEvent } from './liveEvents.js';
import { currentStoreWindows } from './shiftWindows.js';
import { zonedWallTimeToUtcInstant } from './timezone.js';
import { orderAndTime, planRideSelect } from './transportPlan.js';

/**
 * Seats by store shift — riders plan ahead by the shift they work.
 *
 *   a trip     one store shift, one way, one day: "Front Beach 218 ·
 *              Morning · to work · Tue" — every seat booked for it has the
 *              same time (the shift's start to work, its end home)
 *   seats      the vans drivers have put on the trip: a driver accepting a
 *              seat fills their van, until it's full
 *   waitlist   when every van on the trip is full, the rest wait in line —
 *              first booked, first seated. A seat that opens (someone
 *              cancels) goes to the first in line automatically; a driver
 *              adding another van seats more of them.
 *
 * "Other time" rides (no shift) keep the old rule: a driver accepts them.
 */

export interface StoreWindowDef {
  label: string;
  startMinute: number;
  endMinute: number;
}

/** A store's shifts, from its labeled windows ("Morning 6:00–14:00"). */
export async function storeShiftWindows(locationIds: string[], now = new Date()): Promise<Map<string, StoreWindowDef[]>> {
  const defs = await currentStoreWindows(prisma, locationIds, now);
  const out = new Map<string, StoreWindowDef[]>();
  for (const w of defs.values()) {
    const list = out.get(w.locationId) ?? [];
    list.push({ label: w.label, startMinute: w.startMinute, endMinute: w.endMinute });
    out.set(w.locationId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.startMinute - b.startMinute);
  return out;
}

/** When a shift's ride is, on store day `date`: to work, the shift's
 *  start; home, its end — the next morning for an overnight shift. */
export function shiftTargetAt(w: StoreWindowDef, date: string, direction: RideDirection, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (direction === 'TO_WORK') return zonedWallTimeToUtcInstant(y, m, d, w.startMinute, tz);
  const overnight = w.endMinute <= w.startMinute;
  const day = new Date(Date.UTC(y, m - 1, d + (overnight ? 1 : 0)));
  return zonedWallTimeToUtcInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), w.endMinute, tz);
}

export interface TripKey {
  locationId: string;
  direction: RideDirection;
  windowLabel: string;
  targetAt: Date;
}

export function tripKeyOf(r: {
  locationId?: string;
  location?: { id: string };
  direction: RideDirection;
  windowLabel: string | null;
  targetAt: Date;
}): TripKey | null {
  const locationId = r.locationId ?? r.location?.id;
  if (!r.windowLabel || !locationId) return null;
  return { locationId, direction: r.direction, windowLabel: r.windowLabel, targetAt: r.targetAt };
}

const keyString = (k: TripKey) => `${k.locationId}|${k.direction}|${k.windowLabel}|${k.targetAt.toISOString()}`;

function tripWhere(k: TripKey): Prisma.RideWhereInput {
  return { locationId: k.locationId, direction: k.direction, windowLabel: k.windowLabel, targetAt: k.targetAt };
}

export interface TripState {
  /** The vans on the trip, and their seats. */
  runs: Array<{ id: string; status: string; capacity: number; taken: number; departAt: Date; driverUserId: string }>;
  capacity: number;
  taken: number;
  /** Every van on the trip is full (or already on the road) — the rest wait. */
  full: boolean;
  /** Seats asked for and not on a van yet, first booked first. */
  queue: string[];
}

/** The state of one trip: its vans' seats and the line of riders waiting. */
export async function tripState(k: TripKey): Promise<TripState> {
  const [runs, queue] = await Promise.all([
    prisma.rideRun.findMany({
      where: { status: { in: ['PLANNED', 'ACTIVE'] }, rides: { some: { ...tripWhere(k), status: { in: ['SCHEDULED', 'BOARDED'] } } } },
      orderBy: { departAt: 'asc' },
      select: {
        id: true,
        status: true,
        departAt: true,
        driverUserId: true,
        van: { select: { capacity: true } },
        _count: { select: { rides: { where: { status: { in: ['SCHEDULED', 'BOARDED'] } } } } },
      },
    }),
    prisma.ride.findMany({
      where: { ...tripWhere(k), status: 'REQUESTED', runId: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }),
  ]);
  const vans = runs.map((r) => ({
    id: r.id,
    status: r.status,
    capacity: r.van.capacity,
    taken: r._count.rides,
    departAt: r.departAt,
    driverUserId: r.driverUserId,
  }));
  return {
    runs: vans,
    capacity: vans.reduce((n, r) => n + r.capacity, 0),
    taken: vans.reduce((n, r) => n + r.taken, 0),
    full: vans.length > 0 && vans.every((r) => r.status === 'ACTIVE' || r.taken >= r.capacity),
    queue: queue.map((q) => q.id),
  };
}

/** Trip states for many rides at once — keyed by the trip. */
export async function tripStates(
  rides: Array<Parameters<typeof tripKeyOf>[0]>,
): Promise<{ stateOf: (r: Parameters<typeof tripKeyOf>[0]) => TripState | null }> {
  const keys = new Map<string, TripKey>();
  for (const r of rides) {
    const k = tripKeyOf(r);
    if (k) keys.set(keyString(k), k);
  }
  const states = new Map<string, TripState>();
  await Promise.all(
    [...keys.entries()].map(async ([s, k]) => {
      states.set(s, await tripState(k));
    }),
  );
  return {
    stateOf: (r) => {
      const k = tripKeyOf(r);
      return k ? (states.get(keyString(k)) ?? null) : null;
    },
  };
}

/** What a ride says about its trip: the seats, and its place in line. */
export function seatView(
  ride: { id: string; status: string },
  state: TripState | null,
): { seats: { capacity: number; taken: number } | null; waitlist: { position: number; of: number } | null } {
  if (!state) return { seats: null, waitlist: null };
  const i = state.queue.indexOf(ride.id);
  return {
    seats: state.runs.length > 0 ? { capacity: state.capacity, taken: state.taken } : null,
    waitlist: state.full && ride.status === 'REQUESTED' && i >= 0 ? { position: i + 1, of: state.queue.length } : null,
  };
}

/** A seat opened this long before the van leaves still goes to the line. */
const LAST_CALL_MS = 60 * 60_000;

function fmtTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
}

/**
 * Seats open on the trip's vans go to the line — first booked, first
 * seated — automatically: each joins the van, the pickups are re-timed,
 * the rider hears their seat and pickup time, the driver who they're
 * picking up. Only vans that haven't left, and not in their last hour.
 */
export async function seatTheLine(k: TripKey, now = new Date()): Promise<string[]> {
  const seated: string[] = [];
  const runs = await prisma.rideRun.findMany({
    where: {
      status: 'PLANNED',
      departAt: { gt: new Date(now.getTime() + LAST_CALL_MS) },
      rides: { some: { ...tripWhere(k), status: 'SCHEDULED' } },
    },
    orderBy: { departAt: 'asc' },
    select: {
      id: true,
      driverUserId: true,
      van: { select: { name: true, plate: true, capacity: true } },
    },
  });
  for (const run of runs) {
    for (;;) {
      const onboard = await prisma.ride.findMany({
        where: { runId: run.id, status: 'SCHEDULED' },
        select: { ...planRideSelect, pickupAt: true },
      });
      if (onboard.length >= run.van.capacity) break;
      const next = await prisma.ride.findFirst({
        where: { ...tripWhere(k), status: 'REQUESTED', runId: null },
        orderBy: { createdAt: 'asc' },
        select: { ...planRideSelect, associateId: true },
      });
      if (!next) return finish();
      const timed = await orderAndTime([...onboard, next]);
      const ok = await prisma.$transaction(async (tx) => {
        const claimed = await tx.ride.updateMany({
          where: { id: next.id, status: 'REQUESTED', runId: null },
          data: { status: 'SCHEDULED', acceptedAt: now, acceptedById: null },
        });
        if (claimed.count === 0) return false;
        await tx.rideRun.update({ where: { id: run.id }, data: { departAt: timed.departAt } });
        for (const [i, x] of timed.order.entries()) {
          await tx.ride.update({ where: { id: x.ride.id }, data: { runId: run.id, pickupOrder: i + 1, pickupAt: x.pickupAt } });
        }
        return true;
      });
      if (!ok) continue;
      seated.push(next.id);
      const tz = next.location.timezone;
      const pickup = timed.order.find((x) => x.ride.id === next.id)!.pickupAt;
      void trackNotificationWork(
        notifyAssociate(next.associateId, {
          subject: `A seat opened — you're on ${run.van.name}`,
          body:
            `You were first in line for the ${k.windowLabel} shift at ${next.location.name}. ` +
            `${run.van.name}${run.van.plate ? ` · ${run.van.plate}` : ''} picks you up at ${fmtTime(pickup, tz)}.`,
          category: 'transport',
          linkUrl: '/rides',
        }),
      );
      void trackNotificationWork(
        notifyUser(run.driverUserId, {
          subject: `${next.associate.firstName} took the open seat`,
          body: `${next.associate.firstName} ${next.associate.lastName} was first in line for your ${k.windowLabel} run — pickup ${fmtTime(pickup, tz)}.`,
          category: 'transport',
          linkUrl: '/',
        }),
      );
    }
  }
  return finish();

  async function finish() {
    if (seated.length > 0) await nudgeTrip(k);
    return seated;
  }
}

/**
 * The trip just filled: everyone still asking for a seat on it hears
 * they're on the waitlist, and their place in line.
 */
export async function announceWaitlist(k: TripKey): Promise<void> {
  const state = await tripState(k);
  if (!state.full || state.queue.length === 0) return;
  const waiting = await prisma.ride.findMany({
    where: { id: { in: state.queue } },
    select: { id: true, associateId: true, location: { select: { name: true } } },
  });
  for (const r of waiting) {
    const position = state.queue.indexOf(r.id) + 1;
    void trackNotificationWork(
      notifyAssociate(r.associateId, {
        subject: `The ${k.windowLabel} van is full — you're #${position} on the waitlist`,
        body: `If a seat opens on the ${k.windowLabel} shift at ${r.location.name}, it's yours automatically — first in line first. Nothing is charged unless you ride.`,
        category: 'transport',
        linkUrl: '/rides',
      }),
    );
  }
  await nudgeTrip(k);
}

/** Everyone booked on the trip, and the desk, refresh now. */
async function nudgeTrip(k: TripKey): Promise<void> {
  const [riders, desk] = await Promise.all([
    prisma.ride.findMany({ where: { ...tripWhere(k), status: { in: ['REQUESTED', 'SCHEDULED'] } }, select: { associateId: true } }),
    prisma.user.findMany({ where: { role: { in: ['TRANSPORTATION_DIRECTOR', 'DRIVER'] }, status: 'ACTIVE', deletedAt: null }, select: { id: true } }),
  ]);
  const users = await prisma.user.findMany({
    where: { associateId: { in: riders.map((r) => r.associateId) }, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  for (const u of [...users, ...desk]) emitLiveEvent(u.id, 'transport');
}
