import { pendingFor, type PendingMark } from '@/lib/offlineTransport';
import type { Ride, RideRun, RideStatus } from '@/lib/transportApi';
import type { TripKey } from '../ShiftMap';

/**
 * Drive mode, as data — the driver's day and the one next thing to do,
 * worked out from the runs list and nothing else, so every number and
 * every button on the page agrees with every other.
 *
 *   planDay    NOW (the run on the road, else the next one today), the
 *              rest of today, today's finished runs, the runs that never
 *              ran, and the day's counts — one definition for all of them
 *   driveStep  the state machine: pre-trip (once per van per day) →
 *              start → navigate to stop 1 → arrived → board → the next
 *              stop … → the drop-off → complete. One step, one primary.
 *
 * The driver's taps still waiting to send (lib/offlineTransport) count as
 * done here: a rider marked on board in a dead spot is on board, and the
 * card moves on.
 */

/* ----- Stops: riders grouped by where the van stops -------------------------- */

export interface Stop {
  key: string;
  kind: 'home' | 'store';
  label: string;
  address: string;
  rides: Ride[];
  at: string | null;
}

export const riding = (r: Ride) => r.status !== 'CANCELLED';
const homeKey = (r: Ride) => (r.pickup.kind === 'stop' ? `stop:${r.pickup.id}` : `addr:${r.pickup.address.trim().toLowerCase()}`);

type StopHead = Omit<Stop, 'rides' | 'key' | 'at'>;

function group(rides: Ride[], keyOf: (r: Ride) => string, make: (r: Ride) => StopHead): Stop[] {
  const out: Stop[] = [];
  for (const r of rides) {
    const key = keyOf(r);
    let stop = out.find((s) => s.key === key);
    if (!stop) {
      stop = { key, ...make(r), rides: [], at: null };
      out.push(stop);
    }
    stop.rides.push(r);
    const at = r.pickupAt ?? r.targetAt;
    if (!stop.at || at < stop.at) stop.at = at;
  }
  return out;
}

/** Where the van picks up, in order, and where it drops off. To work: homes
 *  (and housing complexes) → the store. Home: the store → each home. */
export function stopsFor(run: RideRun): { pickups: Stop[]; drops: Stop[] } {
  const rides = run.rides.filter(riding).sort((a, b) => (a.pickupOrder ?? 99) - (b.pickupOrder ?? 99));
  const home = (r: Ride) => ({
    kind: 'home' as const,
    label: r.pickup.kind === 'stop' ? r.pickup.name : r.pickup.address,
    address: r.pickup.address,
  });
  const store = (r: Ride) => ({ kind: 'store' as const, label: r.store.name, address: `${r.store.clientName} ${r.store.name}` });
  return run.direction === 'TO_WORK'
    ? { pickups: group(rides, homeKey, home), drops: group(rides, (r) => `store:${r.store.id}`, store) }
    : { pickups: group(rides, (r) => `store:${r.store.id}`, store), drops: group(rides, homeKey, home) };
}

export function runTz(run: RideRun): string {
  return run.rides[0]?.store.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Maria L." — drivers see first names (and an initial, so two Marias at one stop stay two). */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? name;
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0)}.`;
}

/** The ride's status once the taps still waiting to send land. */
export function localStatus(ride: Ride, runId: string, marks: PendingMark[]): RideStatus {
  const p = pendingFor(ride.id, runId, marks);
  if (p === 'board') return 'BOARDED';
  if (p === 'no-show') return 'NO_SHOW';
  if (p === 'undo') return 'SCHEDULED';
  return ride.status;
}

/** When the van got to this stop: the server's word, else an Arrived still on its way. */
export function arrivedAtStop(stop: Stop, runId: string, marks: PendingMark[]): { at: string; sent: boolean } | null {
  const sent = stop.rides.map((r) => r.vanArrivedAt).find(Boolean);
  if (sent) return { at: sent, sent: true };
  const queued = marks.find((m) => m.kind === 'arrived' && m.id === runId && stop.rides.some((r) => m.rideIds?.includes(r.id)));
  return queued ? { at: queued.queuedAt, sent: false } : null;
}

/* ----- The day ----------------------------------------------------------------- */

/**
 * A run that never ran: the sweep closed it (notRun), or it is still
 * "planned" past the sweep's own line — three hours after it should have
 * left, or from a day already over (apps/api lib/transportNotRun,
 * NOT_RUN_AFTER_MINUTES; the sweep runs every 15 minutes). Either way it is
 * history, never "Planned" at the top of the driver's day.
 */
export const NOT_RUN_AFTER_MINUTES = 180;

export function didntRun(run: RideRun, now: number, today?: string): boolean {
  if (run.notRun) return true;
  if (run.status !== 'PLANNED') return false;
  return now - Date.parse(run.departAt) >= NOT_RUN_AFTER_MINUTES * 60_000 || (!!today && run.serviceDate < today);
}

export interface DayCounts {
  /** Today's runs that are running or will run (closed "didn't run" ones are not counted). */
  total: number;
  done: number;
  /** Riders booked on those runs. */
  riders: number;
}

export interface DayPlan {
  /** The run on the road, else the next one today. */
  now: RideRun | null;
  /** Today's other runs still to drive, in order. */
  later: RideRun[];
  /** Today's finished runs, latest first. */
  finished: RideRun[];
  /** Today's and yesterday's runs that never ran. */
  notRun: RideRun[];
  /** The first run after today, for the all-done screen. */
  nextDay: RideRun | null;
  counts: DayCounts;
}

const dayBefore = (ymd: string) => new Date(Date.parse(`${ymd}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const byDepart = (a: RideRun, b: RideRun) => Date.parse(a.departAt) - Date.parse(b.departAt);

/**
 * The day. `apiCounts`: GET /driver/runs' own count of today's runs (the
 * definition /driver/today uses too) — when the answer carries it, the
 * runs line says exactly that; the riders are counted here, on the same runs.
 */
export function planDay(runs: RideRun[], today: string, now = Date.now(), apiCounts?: { total: number; done: number } | null): DayPlan {
  const yesterday = dayBefore(today);
  const live = runs.filter((r) => r.status !== 'CANCELLED' || r.notRun);
  const notRun = live.filter((r) => (r.serviceDate === today || r.serviceDate === yesterday) && didntRun(r, now, today)).sort(byDepart);
  const ran = (r: RideRun) => !didntRun(r, now, today) && r.status !== 'CANCELLED';
  // A run left on the road is NOW whatever its date: only Complete ends it.
  const active = live.filter((r) => r.status === 'ACTIVE' && ran(r)).sort(byDepart);
  const upcoming = live.filter((r) => r.serviceDate === today && r.status === 'PLANNED' && ran(r)).sort(byDepart);
  const current = active[0] ?? upcoming[0] ?? null;
  const later = [...active, ...upcoming].filter((r) => r !== current);
  const todays = live.filter((r) => r.serviceDate === today && ran(r));
  const finished = todays.filter((r) => r.status === 'COMPLETED').sort((a, b) => -byDepart(a, b));
  const nextDay = live.filter((r) => r.serviceDate > today && r.status === 'PLANNED' && ran(r)).sort(byDepart)[0] ?? null;
  return {
    now: current,
    later,
    finished,
    notRun,
    nextDay,
    counts: {
      total: apiCounts?.total ?? todays.length,
      done: apiCounts?.done ?? finished.length,
      riders: todays.reduce((n, r) => n + r.rides.filter(riding).length, 0),
    },
  };
}

/* ----- The pre-trip, once per van per day ---------------------------------------- */

/**
 * The walk around the van is owed when the fleet asks for one and nobody
 * has passed it for THIS van today — the API says so (preTripDone); until
 * every answer carries that, any of today's runs on the van with a passed
 * check counts.
 */
export function preTripOwed(run: RideRun, runs: RideRun[], required: boolean): boolean {
  if (!required || run.status !== 'PLANNED') return false;
  const done =
    run.preTripDone ??
    (run.preTrip?.passed === true || runs.some((r) => r.van.id === run.van.id && r.serviceDate === run.serviceDate && r.preTrip?.passed === true));
  return !done;
}

/* ----- The state machine ----------------------------------------------------------- */

export type DriveStep =
  | { kind: 'pretrip' }
  | { kind: 'start' }
  /** Driving to a pickup: Navigate leads. */
  | { kind: 'navigate'; stop: Stop; n: number; total: number }
  /** Directions opened: Arrived leads. */
  | { kind: 'arrive'; stop: Stop; n: number; total: number }
  /** At the kerb: the manifest, All on board leads. */
  | { kind: 'board'; stop: Stop; n: number; total: number; arrivedAt: string; arrivedSent: boolean }
  /** Everyone's picked up: to the drop-off. */
  | { kind: 'drop'; stop: Stop; n: number; total: number }
  /** Nothing left but the last, irreversible tap. */
  | { kind: 'complete' };

export const navKey = (stop: Stop, phase: 'pickup' | 'drop') => `${phase}:${stop.key}`;

export interface StepInput {
  preTripOwed: boolean;
  marks: PendingMark[];
  /** Directions to this stop were opened already (lib: useNavMemory). */
  navigated: (key: string) => boolean;
}

export function driveStep(run: RideRun, { preTripOwed: owed, marks, navigated }: StepInput): DriveStep {
  if (run.status === 'PLANNED') return owed ? { kind: 'pretrip' } : { kind: 'start' };
  const { pickups, drops } = stopsFor(run);
  const waiting = (s: Stop) => s.rides.some((r) => localStatus(r, run.id, marks) === 'SCHEDULED');
  const i = pickups.findIndex(waiting);
  if (i >= 0) {
    const stop = pickups[i]!;
    const base = { stop, n: i + 1, total: pickups.length };
    const arrived = arrivedAtStop(stop, run.id, marks);
    if (arrived) return { kind: 'board', ...base, arrivedAt: arrived.at, arrivedSent: arrived.sent };
    return navigated(navKey(stop, 'pickup')) ? { kind: 'arrive', ...base } : { kind: 'navigate', ...base };
  }
  // Drop-offs only matter for someone aboard; a stop of no-shows goes straight to Complete.
  const aboard = (s: Stop) => s.rides.some((r) => localStatus(r, run.id, marks) === 'BOARDED');
  const dropsLeft = drops.filter(aboard);
  const d = dropsLeft.findIndex((s) => !navigated(navKey(s, 'drop')));
  if (d >= 0) return { kind: 'drop', stop: dropsLeft[d]!, n: d + 1, total: dropsLeft.length };
  return { kind: 'complete' };
}

/** Riders on board right now (the taps on their way included). */
export function aboardCount(run: RideRun, marks: PendingMark[]): number {
  return run.rides.filter((r) => riding(r) && localStatus(r, run.id, marks) === 'BOARDED').length;
}

/* ----- Overlaps ---------------------------------------------------------------------- */

export interface ConflictLine {
  kind: 'driver' | 'van';
  other: RideRun | null;
  overlapMinutes: number;
}

/** The run's overlaps, each with the other run when it is one of the driver's own. */
export function conflictsOf(run: RideRun, runs: RideRun[]): ConflictLine[] {
  return (run.conflicts ?? []).map((c) => ({ kind: c.kind, other: runs.find((r) => r.id === c.runId) ?? null, overlapMinutes: c.overlapMinutes }));
}

/* ----- Time ---------------------------------------------------------------------------- */

/** Whole minutes and hours for the big countdown: { h, m } of a span (at least one minute). */
export function spanParts(ms: number): { h: number; m: number } {
  const total = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  return { h: Math.floor(total / 60), m: total % 60 };
}

/** The trip a run serves — its store, its shift, its day — for the shift's stops map. */
export function tripOfRun(run: RideRun): TripKey | null {
  const first = run.rides.find(riding) ?? run.rides[0];
  if (!first) return null;
  return {
    locationId: first.store.id,
    direction: run.direction,
    date: run.serviceDate,
    windowLabel: first.windowLabel ?? null,
    storeName: first.store.name,
  };
}

/**
 * The stores a run serves, by name — with the client only when two of the
 * day's stores share a name (the tenant's own words; never "(Coastal
 * Resort Holdings)" on every card).
 */
export function storeNames(run: RideRun, runs: RideRun[] = [run]): string[] {
  const all = runs.flatMap((r) => r.rides.filter(riding).map((x) => x.store));
  const clash = (name: string) => new Set(all.filter((s) => s.name === name).map((s) => s.clientId ?? s.clientName)).size > 1;
  const seen = new Map<string, string>();
  for (const r of run.rides.filter(riding)) {
    if (seen.has(r.store.id)) continue;
    seen.set(r.store.id, clash(r.store.name) && r.store.clientName ? `${r.store.name} (${r.store.clientName})` : r.store.name);
  }
  return [...seen.values()];
}
