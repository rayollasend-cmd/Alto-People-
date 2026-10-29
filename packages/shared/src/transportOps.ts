/**
 * The transport upgrade's contract (2026-10-28): the dispatcher's live
 * operations, tomorrow's readiness, moving a rider between runs, and the
 * rider's share link. Types only, plus the key lists — nothing here runs.
 *
 * The rest of transport keeps its shapes in apps/web/src/lib/transportApi.ts;
 * the fields this upgrade adds to them (MyLiveRide, RideRun, the driver's run)
 * are listed at the bottom as `…Additions` and merged there.
 */

/* ------------------------------------------------------------------ fleet */

/** What a van is doing right now. */
export type FleetVanState =
  | 'on_road' // a run is ACTIVE and its phone is reporting
  | 'no_signal' // a run is ACTIVE but the last position is older than 3 minutes
  | 'planned' // no run is out; one leaves later today
  | 'idle' // nothing today, or the day's runs are done
  | 'out_of_service';

export interface FleetPosition {
  lat: number;
  lng: number;
  heading: number | null;
  /** When the position was taken (ISO). */
  at: string;
}

export interface FleetVan {
  vanId: string;
  name: string;
  plate: string | null;
  capacity: number;
  state: FleetVanState;
  /** Live while on the road; otherwise where the van was last seen (the end of its last run). */
  position: FleetPosition | null;
  /** Minutes since `position.at`. */
  positionAgeMinutes: number | null;
  /** The run it is on now. */
  run: {
    runId: string;
    direction: 'TO_WORK' | 'FROM_WORK';
    departAt: string;
    driverUserId: string;
    driverName: string;
    driverPhone: string | null;
    onBoard: number;
    toPickUp: number;
    nextStop: { label: string; scheduledAt: string | null; etaAt: string | null } | null;
    /** Minutes behind the schedule at the next stop (0 when on time or early). */
    lateMinutes: number;
  } | null;
  /** The next run it leaves on today, when it isn't out. */
  nextRun: { runId: string; departAt: string; driverName: string; riders: number } | null;
}

/* ------------------------------------------------------------- exceptions */

export type TransportExceptionKind =
  | 'sos' // the driver pressed SOS and no one has acknowledged it
  | 'late' // a van is 5+ minutes behind at its next stop
  | 'stalled' // the van has not moved and the run is not done (the safety watch)
  | 'not_started' // a run is past its departure and has not started
  | 'driver_double_booked' // one driver on two runs that overlap
  | 'van_double_booked' // one van on two runs that overlap
  | 'needs_van' // riders booked for today with no run
  | 'pre_trip_failed' // a run's pre-trip check failed and no later one passed
  | 'van_out_of_service' // a van marked out of service has a run today
  | 'credential_lapsed' // a driver with a run today has a lapsed licence, DOT card or training
  | 'no_show' // a rider was marked no-show in the last 2 hours (an FYI)
  | 'open_issue' // a rider or driver report is open
  | 'didnt_run'; // a planned run never started (closed by the sweep)

export type TransportExceptionSeverity = 'high' | 'medium' | 'low';

export type TransportExceptionActionKind =
  | 'open_run' // scroll/open the run on the board
  | 'call_driver' // tel: the driver
  | 'ack_sos' // POST /transport/runs/:id/sos/ack
  | 'assign_van' // open the needs-a-van rider(s) for dispatch
  | 'open_issue' // the Issues tab, that issue
  | 'open_setup' // Setup › Drivers or Vans
  | 'open_ride'; // the rider drawer

export interface TransportException {
  /** Stable across polls, so a dismissed or acted-on item doesn't jump. */
  id: string;
  kind: TransportExceptionKind;
  severity: TransportExceptionSeverity;
  /** One line, with its number: "Van 2 is 9 minutes late at Gulf Pines". */
  title: string;
  /** What it means / what fixes it, one sentence. */
  detail: string;
  /** When it began (ISO). */
  at: string;
  runId?: string;
  rideIds?: string[];
  vanId?: string;
  driverUserId?: string;
  /** The one-click fix. */
  action: { label: string; kind: TransportExceptionActionKind; target?: string };
}

/* ------------------------------------------------------------------- KPIs */

export type TransportKpiId = 'onTime' | 'utilization' | 'costPerRide' | 'noShowRate';

export interface TransportKpi {
  id: TransportKpiId;
  label: string;
  /** pct: 0–100 with one decimal; money: dollars. */
  unit: 'pct' | 'money';
  /** The last 7 days, in `unit`. */
  value: number | null;
  /** The 7 days before. */
  compare: number | null;
  delta: number | null;
  betterWhen: 'up' | 'down';
  /** good / watch / bad against fixed thresholds (stated in `definition`), none without data. */
  status: 'good' | 'watch' | 'bad' | 'none';
  statusLabel: string;
  /** Weekly values, the last 8 complete weeks, oldest first. */
  trend: Array<number | null>;
  definition: string;
}

/** GET /transport/ops?date= — the dispatcher's live operations. */
export interface TransportOpsBoard {
  date: string;
  timezone: string;
  generatedAt: string;
  vans: FleetVan[];
  /** Highest severity first, then oldest. */
  exceptions: TransportException[];
  /** onTime, utilization, costPerRide, noShowRate. */
  kpis: TransportKpi[];
  /** Where the map opens when no van has a position: the depot or the first store. */
  center: { lat: number; lng: number } | null;
}

/* -------------------------------------------------------------- readiness */

export type TransportReadinessId =
  | 'riders_placed' // every booked ride has a run
  | 'seats' // no run is over its van's capacity
  | 'drivers_assigned_ok' // no driver double-booked, none over max hours, rest respected
  | 'credentials' // every assigned driver's licence, DOT card and training current
  | 'vans_ready' // every van with a run is in service, inspection/registration/insurance current
  | 'vans_double_booked'; // no van on two overlapping runs

export interface TransportReadinessItem {
  id: TransportReadinessId;
  label: string;
  ok: boolean;
  /** How many things are wrong (0 when ok). */
  count: number;
  /** One sentence: "3 riders have no van yet." / "Every driver's papers are current." */
  detail: string;
  /** Where to fix it. */
  action: { label: string; kind: 'plan' | 'open_needs_van' | 'open_setup_drivers' | 'open_setup_vans' | 'open_board'; target?: string } | null;
}

/** GET /transport/readiness?date= (default: tomorrow in the company calendar). */
export interface TransportReadiness {
  date: string;
  ready: boolean;
  items: TransportReadinessItem[];
  /** Counts for the headline: "31 riders on 4 runs". */
  riders: number;
  runs: number;
}

/* ------------------------------------------------------------------ moves */

/** POST /transport/rides/:id/move — onto another run of the same day and direction, or off any run (null). */
export interface MoveRideInput {
  toRunId: string | null;
  /** Where in the new run's pickup order; appended when omitted. */
  pickupOrder?: number;
}

export interface MoveRideResult {
  rideId: string;
  fromRunId: string | null;
  toRunId: string | null;
  /** Seats on the destination run after the move. */
  seats: { taken: number; capacity: number } | null;
  /** Non-blocking warnings: "Van 1 is now at 12 of 12 seats." */
  warnings: string[];
}

/* ------------------------------------------------------------------ share */

/** POST /transport/me/rides/:id/share — a link a rider can text to someone: the van and the ETA, nothing else. */
export interface RideShareLink {
  url: string;
  expiresAt: string;
}

/* -------------------------------------------- additions to existing shapes */

/** Added to MyLiveRide (GET /transport/me/live). */
export interface MyLiveRideAdditions {
  /** The driver's first name only ("Mike"). */
  driverFirstName: string | null;
  /** How the van looks, when the fleet record has it. */
  vanLook: { color: string | null; make: string | null; model: string | null; year: number | null } | null;
  /** Where exactly to wait — the stop's note ("By the front gate, under the awning"). */
  pickupNote: string | null;
  /** How long the driver waits at the stop before a no-show can be marked. */
  waitMinutes: number;
  /** The dispatch line from transport settings. */
  dispatchPhone: string | null;
  /** The fare for this ride and how it is paid ("Taken from your pay on Nov 6"). */
  fare: { cents: number; words: string } | null;
}

/** Added to each run on GET /transport/board and the driver's runs. */
export interface RunAdditions {
  /** A planned run that never started; the sweep closed it and its rides. */
  notRun: boolean;
  /** Overlapping runs for the same driver or van (the board's double-booking rule). */
  conflicts: Array<{ kind: 'driver' | 'van'; runId: string; overlapMinutes: number }>;
}

/** Added to each run on the driver's GET /transport/driver/runs. */
export interface DriverRunAdditions extends RunAdditions {
  /** A passed pre-trip check exists for this van today (one check per van per day). */
  preTripDone: boolean;
}
