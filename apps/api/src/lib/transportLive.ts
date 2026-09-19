import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { geocode, type GeoPoint } from './geocode.js';
import { notifyAssociate, notifyUser, trackNotificationWork } from './notify.js';
import { emitLiveEvent } from './liveEvents.js';

/**
 * The vans live — phase 2 of transportation.
 *
 * The driver's phone sends the van's position while a run is on the road
 * (POST /transport/driver/runs/:id/location). From the last position and
 * the run's remaining stops in order, planRun estimates when the van
 * reaches each pickup, each store and each drop-off:
 *
 *   drive time = straight-line distance × ROAD_FACTOR ÷ CRUISE_MPS,
 *                plus DWELL_S at every stop
 *
 * — an estimate ("about 8 min"), no routing service needed. On each ping:
 *   - a rider whose pickup is NEAR_MINUTES away hears it, once
 *   - a TO_WORK run heading into a store LATE_ALERT_MINUTES or more past
 *     its riders' arrive-by tells that store's supervisors (and the
 *     transportation desk), once per run — heads-up only
 *   - riders, the desk and those supervisors get a live nudge so their
 *     maps refetch now instead of on the next poll
 *
 * Privacy: a rider sees the van and their own pickup — never another
 * rider's address. The van's position is only shared while the run is
 * ACTIVE. The trail (RideRunPing) is kept 30 days for late-van disputes.
 */

export const ROAD_FACTOR = 1.35;
export const CRUISE_MPS = 11.2; // ~25 mph, stop-and-go
export const DWELL_S = 60;
export const NEAR_MINUTES = 10;
export const LATE_ALERT_MINUTES = 5;
/** A position older than this reads "last seen …", not live. */
export const STALE_MS = 3 * 60_000;
/** Drop pings closer together than this (a phone firing too often). */
export const MIN_PING_GAP_MS = 4_000;
const TRAIL_RETENTION_DAYS = 30;

export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function driveSeconds(a: GeoPoint, b: GeoPoint): number {
  return (haversineM(a, b) * ROAD_FACTOR) / CRUISE_MPS;
}

const num = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? null : Number(d));
function point(lat: Prisma.Decimal | number | null | undefined, lng: Prisma.Decimal | number | null | undefined): GeoPoint | null {
  const la = num(lat);
  const ln = num(lng);
  return la === null || ln === null ? null : { lat: la, lng: ln };
}

/* ----- The plan: every remaining stop, in order, with an ETA -------------- */

export interface PlanRide {
  id: string;
  status: string;
  pickupOrder: number | null;
  targetAt: Date;
  locationId: string;
  home: GeoPoint | null;
}

export interface Waypoint {
  kind: 'pickup' | 'store' | 'drop';
  rideIds: string[];
  locationId: string | null;
  point: GeoPoint | null;
  etaAt: Date | null;
}

export interface RunPlan {
  waypoints: Waypoint[];
  /** When the van reaches the rider (home for TO_WORK, the store for FROM_WORK). */
  pickupEta: Map<string, Date | null>;
  /** When the rider gets where they're going. */
  dropEta: Map<string, Date | null>;
  storeEta: Map<string, Date | null>;
  /** TO_WORK: minutes past the earliest arrive-by at each store (≥ 0). */
  lateMinutes: Map<string, number>;
}

const byOrder = (a: PlanRide, b: PlanRide) =>
  (a.pickupOrder ?? 999) - (b.pickupOrder ?? 999) || a.targetAt.getTime() - b.targetAt.getTime();

/** Stores in the order the van visits them: earliest arrive-by / leave first. */
function storesInOrder(rides: PlanRide[]): string[] {
  const first = new Map<string, number>();
  for (const r of rides) {
    const t = r.targetAt.getTime();
    if (!first.has(r.locationId) || t < first.get(r.locationId)!) first.set(r.locationId, t);
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

export function planRun(opts: {
  direction: 'TO_WORK' | 'FROM_WORK';
  van: GeoPoint | null;
  now: Date;
  rides: PlanRide[];
  stores: Map<string, GeoPoint | null>;
}): RunPlan {
  const waiting = opts.rides.filter((r) => r.status === 'SCHEDULED').sort(byOrder);
  const aboard = opts.rides.filter((r) => r.status === 'BOARDED');
  const riding = [...waiting, ...aboard].sort(byOrder);
  const waypoints: Waypoint[] = [];
  if (opts.direction === 'TO_WORK') {
    for (const r of waiting) waypoints.push({ kind: 'pickup', rideIds: [r.id], locationId: null, point: r.home, etaAt: null });
    for (const loc of storesInOrder(riding)) {
      waypoints.push({
        kind: 'store',
        rideIds: riding.filter((r) => r.locationId === loc).map((r) => r.id),
        locationId: loc,
        point: opts.stores.get(loc) ?? null,
        etaAt: null,
      });
    }
  } else {
    for (const loc of storesInOrder(waiting)) {
      waypoints.push({
        kind: 'store',
        rideIds: waiting.filter((r) => r.locationId === loc).map((r) => r.id),
        locationId: loc,
        point: opts.stores.get(loc) ?? null,
        etaAt: null,
      });
    }
    for (const r of riding) waypoints.push({ kind: 'drop', rideIds: [r.id], locationId: null, point: r.home, etaAt: null });
  }

  // Walk the route from the van. A stop without coordinates gets no ETA
  // and the clock carries on from the last known point.
  let at: GeoPoint | null = opts.van;
  let t = opts.now.getTime();
  for (const w of waypoints) {
    if (!at || !w.point) continue;
    t += driveSeconds(at, w.point) * 1000;
    w.etaAt = new Date(t);
    t += DWELL_S * 1000;
    at = w.point;
  }

  const pickupEta = new Map<string, Date | null>();
  const dropEta = new Map<string, Date | null>();
  const storeEta = new Map<string, Date | null>();
  for (const w of waypoints) {
    if (w.kind === 'store' && w.locationId) storeEta.set(w.locationId, w.etaAt);
    for (const id of w.rideIds) {
      if (opts.direction === 'TO_WORK') {
        if (w.kind === 'pickup') pickupEta.set(id, w.etaAt);
        else dropEta.set(id, w.etaAt);
      } else if (w.kind === 'store') pickupEta.set(id, w.etaAt);
      else dropEta.set(id, w.etaAt);
    }
  }
  const lateMinutes = new Map<string, number>();
  if (opts.direction === 'TO_WORK') {
    for (const w of waypoints.filter((x) => x.kind === 'store' && x.locationId && x.etaAt)) {
      const due = Math.min(...riding.filter((r) => r.locationId === w.locationId).map((r) => r.targetAt.getTime()));
      lateMinutes.set(w.locationId!, Math.max(0, Math.round((w.etaAt!.getTime() - due) / 60_000)));
    }
  }
  return { waypoints, pickupEta, dropEta, storeEta, lateMinutes };
}

/* ----- Points from the database (looked up once, then remembered) -------- */

export const liveRunInclude = {
  van: { select: { id: true, name: true, plate: true, capacity: true } },
  driver: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
  rides: {
    where: { status: { in: ['SCHEDULED', 'BOARDED', 'COMPLETED', 'NO_SHOW'] } },
    orderBy: [{ pickupOrder: 'asc' }, { targetAt: 'asc' }],
    select: {
      id: true,
      status: true,
      direction: true,
      pickupOrder: true,
      pickupAt: true,
      targetAt: true,
      address: true,
      lat: true,
      lng: true,
      nearNotifiedAt: true,
      stop: { select: { id: true, name: true, address: true, lat: true, lng: true } },
      associate: { select: { id: true, firstName: true, lastName: true } },
      location: {
        select: {
          id: true,
          name: true,
          timezone: true,
          clientId: true,
          addressLine1: true,
          city: true,
          state: true,
          zip: true,
          latitude: true,
          longitude: true,
        },
      },
    },
  },
} satisfies Prisma.RideRunInclude;

export type LiveRunRow = Prisma.RideRunGetPayload<{ include: typeof liveRunInclude }>;
type LiveRide = LiveRunRow['rides'][number];
type LiveLocation = LiveRide['location'];

/** The rider's home end — the stop, or the ride's own address. Looked up
 *  and saved the first time it's needed. */
export async function homePoint(r: {
  id: string;
  address: string | null;
  lat: Prisma.Decimal | null;
  lng: Prisma.Decimal | null;
  stop: { id: string; address: string; lat: Prisma.Decimal | null; lng: Prisma.Decimal | null } | null;
}): Promise<GeoPoint | null> {
  if (r.stop) {
    const p = point(r.stop.lat, r.stop.lng);
    if (p) return p;
    const found = await geocode(r.stop.address);
    if (found) await prisma.transportStop.update({ where: { id: r.stop.id }, data: { lat: found.lat, lng: found.lng } });
    return found;
  }
  const p = point(r.lat, r.lng);
  if (p) return p;
  const found = await geocode(r.address);
  if (found) await prisma.ride.update({ where: { id: r.id }, data: { lat: found.lat, lng: found.lng } });
  return found;
}

export function storeAddress(l: { addressLine1: string | null; city: string | null; state: string | null; zip: string | null }): string {
  return [l.addressLine1, l.city, [l.state, l.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/** The store's point: its own coordinates (the clock-in geofence's), else
 *  its address looked up — cached, never written to the Location (that
 *  would switch on a geofence nobody configured). */
export async function storePoint(l: {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: Prisma.Decimal | null;
  longitude: Prisma.Decimal | null;
}): Promise<GeoPoint | null> {
  return point(l.latitude, l.longitude) ?? (await geocode(storeAddress(l)));
}

export interface RunLive {
  van: { lat: number; lng: number; heading: number | null; speedMps: number | null; at: string } | null;
  stale: boolean;
  plan: RunPlan;
  homes: Map<string, GeoPoint | null>;
  stores: Map<string, { point: GeoPoint | null; location: LiveLocation }>;
}

export async function computeRunLive(run: LiveRunRow, now = new Date()): Promise<RunLive> {
  const homes = new Map<string, GeoPoint | null>();
  const stores = new Map<string, { point: GeoPoint | null; location: LiveLocation }>();
  for (const r of run.rides) {
    homes.set(r.id, await homePoint(r));
    if (!stores.has(r.location.id)) stores.set(r.location.id, { point: await storePoint(r.location), location: r.location });
  }
  const vanPoint = run.status === 'ACTIVE' ? point(run.lastLat, run.lastLng) : null;
  const plan = planRun({
    direction: run.direction,
    van: vanPoint,
    now,
    rides: run.rides.map((r) => ({
      id: r.id,
      status: r.status,
      pickupOrder: r.pickupOrder,
      targetAt: r.targetAt,
      locationId: r.location.id,
      home: homes.get(r.id) ?? null,
    })),
    stores: new Map([...stores.entries()].map(([id, s]) => [id, s.point])),
  });
  return {
    van:
      vanPoint && run.lastLocationAt
        ? {
            ...vanPoint,
            heading: run.lastHeading,
            speedMps: run.lastSpeedMps,
            at: run.lastLocationAt.toISOString(),
          }
        : null,
    stale: !run.lastLocationAt || now.getTime() - run.lastLocationAt.getTime() > STALE_MS,
    plan,
    homes,
    stores,
  };
}

/* ----- A ping: the alerts, and the nudge to everyone watching -------------- */

function fmtTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
}

async function watchers(run: LiveRunRow): Promise<string[]> {
  const clientIds = [...new Set(run.rides.map((r) => r.location.clientId))];
  const rows = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      OR: [
        { associateId: { in: run.rides.map((r) => r.associate.id) } },
        { role: 'TRANSPORTATION_DIRECTOR' },
        { role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] }, clientId: { in: clientIds } },
      ],
    },
    select: { id: true },
  });
  return rows.map((u) => u.id);
}

export async function afterPing(runId: string, now = new Date()): Promise<void> {
  const run = await prisma.rideRun.findUnique({ where: { id: runId }, include: liveRunInclude });
  if (!run || run.status !== 'ACTIVE') return;
  const live = await computeRunLive(run, now);

  // "Your van is about 8 min away" — once per ride.
  for (const r of run.rides.filter((x) => x.status === 'SCHEDULED' && !x.nearNotifiedAt)) {
    const eta = live.plan.pickupEta.get(r.id);
    if (!eta) continue;
    const mins = Math.max(1, Math.round((eta.getTime() - now.getTime()) / 60_000));
    if (mins > NEAR_MINUTES) continue;
    const claimed = await prisma.ride.updateMany({ where: { id: r.id, nearNotifiedAt: null }, data: { nearNotifiedAt: now } });
    if (claimed.count === 0) continue;
    const where = run.direction === 'TO_WORK' ? (r.stop?.name ?? 'your pickup') : r.location.name;
    void trackNotificationWork(
      notifyAssociate(r.associate.id, {
        subject: `Your van is about ${mins} min away`,
        body: `${run.van.name} is about ${mins} min from ${where}. Be ready a few minutes early.`,
        category: 'transport',
        linkUrl: '/rides',
      }),
    );
  }

  // Running late into a store — the supervisors' heads-up, once per run.
  if (run.direction === 'TO_WORK' && !run.lateAlertedAt) {
    const late = [...live.plan.lateMinutes.entries()].filter(([, m]) => m >= LATE_ALERT_MINUTES);
    if (late.length > 0) {
      const claimed = await prisma.rideRun.updateMany({ where: { id: run.id, lateAlertedAt: null }, data: { lateAlertedAt: now } });
      if (claimed.count > 0) {
        for (const [locationId, minutes] of late) {
          const store = live.stores.get(locationId)!.location;
          const riders = run.rides.filter((r) => r.location.id === locationId && (r.status === 'SCHEDULED' || r.status === 'BOARDED'));
          const eta = live.plan.storeEta.get(locationId)!;
          const due = new Date(Math.min(...riders.map((r) => r.targetAt.getTime())));
          const subject = `${run.van.name} is running about ${minutes} min late`;
          const body =
            `${riders.map((r) => `${r.associate.firstName} ${r.associate.lastName}`).join(', ')} — ` +
            `expected at ${store.name} around ${fmtTime(eta, store.timezone)} (due ${fmtTime(due, store.timezone)}). Heads-up only.`;
          const sups = await prisma.user.findMany({
            where: {
              role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'TRANSPORTATION_DIRECTOR'] },
              status: 'ACTIVE',
              deletedAt: null,
              OR: [{ clientId: store.clientId }, { role: 'TRANSPORTATION_DIRECTOR' }],
            },
            select: { id: true, role: true },
          });
          for (const u of sups) {
            void trackNotificationWork(
              notifyUser(u.id, {
                subject,
                body,
                category: 'transport',
                linkUrl: u.role === 'TRANSPORTATION_DIRECTOR' ? '/?tab=live' : '/',
              }),
            );
          }
        }
      }
    }
  }

  for (const id of await watchers(run)) emitLiveEvent(id, 'transport');
}

/** The van's trail is kept 30 days. */
export async function runVanTrailRetention(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRAIL_RETENTION_DAYS * 86_400_000);
  const r = await prisma.rideRunPing.deleteMany({ where: { at: { lt: cutoff } } });
  if (r.count > 0) console.log(`[alto-people/api] van trail retention: removed ${r.count} pings (>${TRAIL_RETENTION_DAYS}d)`);
  return r.count;
}

let timer: NodeJS.Timeout | null = null;
export function startVanTrailRetentionCron(): void {
  if (timer) return;
  const seconds = env.VAN_TRAIL_RETENTION_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void runVanTrailRetention().catch((err) => console.error('[alto-people/api] van trail retention failed:', err));
  };
  tick();
  timer = setInterval(tick, seconds * 1000);
  timer.unref();
}
