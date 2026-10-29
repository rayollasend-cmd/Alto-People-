import { NO_SHOW_WAIT_MS, type MyLiveRide, type Ride, type RiderSignal, type VanLook } from '@/lib/transportApi';

/**
 * The rider's trip once a van is on it — one state at a time, the way a
 * ride-hailing app reads (the transport upgrade, 2026-10-28):
 *
 *   before   the van hasn't left: "Van 1 leaves at 2:10 PM — pickup 2:18 PM"
 *   onWay    the van is out: "Mike is 6 min away" (late said honestly)
 *   arrived  the driver tapped Arrived: "Mike is here — look for …", and the wait
 *   onBoard  on the van: "On the way — arriving 2:41 PM", with a progress bar
 *
 * (Done is the rating prompt: the ride has left this list by then.)
 * Pure — the page, the Home card and the tests all read the same answer.
 */

export type LivePhase = 'before' | 'onWay' | 'arrived' | 'onBoard';

export interface LiveTripView {
  phase: LivePhase;
  /** The store's zone — every time on the card is read in it. */
  tz: string;
  /** "Mike" — first name only; '' when no one is named yet. */
  driverFirst: string;
  vanName: string;
  plate: string | null;
  /** "White Ford Transit" — colour, make, model; '' when the fleet record has none. */
  look: string;
  departAt: string | null;
  /** The scheduled pickup (null while the run hasn't set one). */
  pickupAt: string | null;
  /** The ETA that matters now: the pickup on the way, the drop-off on board. */
  etaAt: string | null;
  /** Whole minutes to `etaAt` (on the way, at least 1); null without an ETA. */
  minutesAway: number | null;
  /** Under a minute out. */
  arrivingNow: boolean;
  /** Minutes behind schedule (0 on time). */
  lateMinutes: number;
  arrivedAt: string | null;
  /** How long the driver waits at the stop once there. */
  waitMs: number;
  /** Arrived: the time left of that wait (0 once it's up). */
  waitLeftMs: number;
  /** What the rider already told the driver. */
  signal: RiderSignal | null;
  stopsBefore: number | null;
  /** The van's phone hasn't reported for a while. */
  stale: boolean;
  /** When the position was taken. */
  positionAt: string | null;
}

/** A van is on this ride (accepted by a driver, or the live feed has one). */
export function hasVan(ride: Ride, live: MyLiveRide | null): boolean {
  return !!ride.run || !!live?.van;
}

export function livePhase(ride: Ride, live: MyLiveRide | null): LivePhase {
  if (ride.status === 'BOARDED' || live?.status === 'BOARDED') return 'onBoard';
  if (ride.vanArrivedAt || live?.vanArrivedAt) return 'arrived';
  if (ride.run?.status === 'ACTIVE' || live?.runStatus === 'ACTIVE') return 'onWay';
  return 'before';
}

/** "White Ford Transit" — what to look for at the curb (no year: nobody reads a year off a van). */
export function lookText(v: VanLook | null | undefined): string {
  if (!v) return '';
  return [v.color, v.make, v.model].filter((x) => x !== null && x !== undefined && String(x).trim() !== '').join(' ');
}

export function liveTripView(ride: Ride, live: MyLiveRide | null, now: number): LiveTripView {
  const l = live && live.rideId === ride.id ? live : null;
  const phase = livePhase(ride, l);
  const tz = l?.timezone ?? ride.store.timezone;
  const driverFirst = (l?.driverFirstName ?? l?.driver ?? ride.run?.driver.name ?? '').trim().split(/\s+/)[0] ?? '';
  const vanName = ride.run?.van.name ?? l?.van?.name ?? '';
  const plate = l?.van?.plate ?? ride.run?.van.plate ?? null;
  const look = lookText(l?.vanLook) || lookText(ride.run?.van);
  const out = l?.runStatus === 'ACTIVE' ? l : null;
  const etaAt = phase === 'onBoard' ? (out?.destination.etaAt ?? null) : phase === 'onWay' ? (out?.pickup.etaAt ?? null) : null;
  const msAway = etaAt ? Date.parse(etaAt) - now : null;
  const arrivedAt = ride.vanArrivedAt ?? l?.vanArrivedAt ?? null;
  const waitMs = l?.waitMinutes && l.waitMinutes > 0 ? l.waitMinutes * 60_000 : NO_SHOW_WAIT_MS;
  return {
    phase,
    tz,
    driverFirst,
    vanName,
    plate,
    look,
    departAt: ride.run?.departAt ?? l?.departAt ?? null,
    pickupAt: ride.pickupAt ?? l?.pickup.scheduledAt ?? null,
    etaAt,
    minutesAway: msAway === null ? null : Math.max(1, Math.round(msAway / 60_000)),
    arrivingNow: msAway !== null && msAway < 60_000,
    lateMinutes: Math.max(0, Math.round(out?.lateMinutes ?? 0)),
    arrivedAt,
    waitMs,
    waitLeftMs: arrivedAt ? Math.max(0, Date.parse(arrivedAt) + waitMs - now) : 0,
    signal: ride.riderSignal?.kind ?? l?.riderSignal ?? null,
    stopsBefore: out ? out.stopsBefore : null,
    stale: !!l?.stale,
    positionAt: l?.position?.at ?? null,
  };
}

/** How far into the ride, 0–1, by the clock (on board: boarded → the ETA). */
export function tripProgress(from: string | null, to: string | null, now: number): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!(b > a)) return null;
  return Math.max(0.04, Math.min(1, (now - a) / (b - a)));
}

/** The trip owns the screen's one gold button ("I'm outside") while the van is coming or waiting. */
export function liveTripOwnsGold(ride: Ride, live: MyLiveRide | null): boolean {
  if (!hasVan(ride, live)) return false;
  const phase = livePhase(ride, live && live.rideId === ride.id ? live : null);
  const signal = ride.riderSignal?.kind ?? (live?.rideId === ride.id ? live.riderSignal : null);
  return (phase === 'onWay' || phase === 'arrived') && signal !== 'OUTSIDE';
}

/** The van is coming, waiting, or carrying them — the screen belongs to the trip. */
export function tripInProgress(ride: Ride, live: MyLiveRide | null): boolean {
  if (!hasVan(ride, live)) return false;
  return livePhase(ride, live && live.rideId === ride.id ? live : null) !== 'before';
}
