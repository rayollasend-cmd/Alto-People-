import type { Ride, RideRun, RideStatus } from '@/lib/transportApi';

/**
 * How the desk says a ride's state — one word or two, on a status chip from
 * the palette's scales (Badge): waiting is caution, on a van is info, on board
 * is in flight (accent), done is positive, a no-show is negative, and a ride
 * that ended without happening (cancelled, the van didn't run) is neutral.
 */

export type ChipVariant = 'accent' | 'success' | 'pending' | 'destructive' | 'default' | 'info';

export const STATUS_WORDS: Record<RideStatus, string> = {
  REQUESTED: 'Needs a van',
  SCHEDULED: 'On a van',
  BOARDED: 'On board',
  COMPLETED: 'Done',
  NO_SHOW: 'No-show',
  CANCELLED: 'Cancelled',
};

const VARIANT: Record<RideStatus, ChipVariant> = {
  REQUESTED: 'pending',
  SCHEDULED: 'info',
  BOARDED: 'accent',
  COMPLETED: 'success',
  NO_SHOW: 'destructive',
  CANCELLED: 'default',
};

/**
 * The van this ride was on never left: the sweep closed the run and its
 * rides ("The van didn't run"), never charged. The run's own flag when the
 * answer carries it on the ride's run; the sweep's reason otherwise.
 */
export function rideDidntRun(r: Pick<Ride, 'status' | 'cancelReason' | 'run'>): boolean {
  if (r.status !== 'CANCELLED') return false;
  if ((r.run as { notRun?: boolean } | null)?.notRun) return true;
  return /didn[’']t run/i.test(r.cancelReason ?? '');
}

/** The ride's time: its pickup when it has one, else the arrive-by / leave-at. */
export function rideTimeMs(r: Pick<Ride, 'pickupAt' | 'targetAt'>): number {
  return Date.parse(r.pickupAt ?? r.targetAt);
}

export function rideStatusWords(r: Pick<Ride, 'status' | 'cancelReason' | 'run'>): { label: string; variant: ChipVariant } {
  if (rideDidntRun(r)) return { label: 'Didn’t run', variant: 'default' };
  return { label: STATUS_WORDS[r.status], variant: VARIANT[r.status] };
}

/**
 * Cancel is for a ride that can still be stopped: waiting or on a van that
 * hasn't left, and its time still ahead. A ride whose time has passed, one on
 * a van that's out, and anything done, cancelled or a no-show has no Cancel.
 */
export function canCancelRide(r: Pick<Ride, 'status' | 'pickupAt' | 'targetAt' | 'run'>, now = Date.now()): boolean {
  if (r.status !== 'REQUESTED' && r.status !== 'SCHEDULED') return false;
  if (r.run && r.run.status !== 'PLANNED') return false;
  return rideTimeMs(r) > now;
}

/**
 * A planned run whose departure is well past and that never started — the
 * sweep will close it as "didn't run"; until then it is not "Planned".
 */
export const NOT_STARTED_GRACE_MS = 15 * 60_000;
export function runNotStarted(run: Pick<RideRun, 'status' | 'departAt' | 'notRun'>, now = Date.now()): boolean {
  return run.status === 'PLANNED' && !run.notRun && Date.parse(run.departAt) < now - NOT_STARTED_GRACE_MS;
}

export const firstName = (name: string) => name.split(' ')[0] ?? name;
