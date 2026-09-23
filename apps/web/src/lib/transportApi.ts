import { apiFetch } from './api';

/**
 * Transportation — the Alto vans. Associates book a seat to or from work
 * (independent of the schedule, at least `cutoffHours` ahead); the
 * Transportation Director dispatches the bookings onto van runs; the driver
 * marks each rider on board or a no-show; what's owed comes out of pay.
 * Money is in cents throughout.
 */

export type RideDirection = 'TO_WORK' | 'FROM_WORK';
export type RideStatus = 'REQUESTED' | 'SCHEDULED' | 'BOARDED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';
export type RideRunStatus = 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type TransportIssueCategory =
  | 'LATE_VAN'
  | 'MISSED_PICKUP'
  | 'CHARGE_DISPUTE'
  | 'SAFETY'
  | 'VEHICLE'
  | 'CONDUCT'
  | 'OTHER';
export type TransportIssueStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface TransportSettings {
  fareCents: number;
  noShowFeeCents: number;
  cutoffHours: number;
}

export interface Ride {
  id: string;
  direction: RideDirection;
  /** Arrive-by (to work) or pick-up-at (from work). */
  targetAt: string;
  serviceDate: string;
  status: RideStatus;
  shiftId: string | null;
  /** The store shift the seat is for ("Morning"); null: an other time. */
  windowLabel?: string | null;
  note: string | null;
  pickup:
    | { kind: 'stop'; id: string; name: string; address: string }
    | { kind: 'address'; id: null; name: null; address: string };
  /** The home end's coordinates, when known. */
  point: GeoPoint | null;
  store: { id: string; name: string; timezone: string; clientId: string; clientName: string };
  rider: { associateId: string; name: string; phone: string | null };
  pickupOrder: number | null;
  pickupAt: string | null;
  run: {
    id: string;
    status: RideRunStatus;
    departAt: string;
    van: VanLook & { id: string; name: string; plate: string | null };
    driver: { userId: string; name: string; associateId: string | null };
  } | null;
  fareCents: number;
  noShowFeeCents: number;
  owedCents: number;
  waived: boolean;
  waiveReason: string | null;
  charged: boolean;
  boardedAt: string | null;
  completedAt: string | null;
  noShowAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** The driver tapped "Arrived" at this pickup. */
  vanArrivedAt: string | null;
  /** The rider's word to the driver. */
  riderSignal: { kind: RiderSignal; at: string } | null;
  /** A driver (or the director) put the seat on a van. */
  acceptedAt: string | null;
  /** Drivers who declined the seat request; all of them have. */
  declines: number;
  allDeclined: boolean;
  createdAt: string;
  /** The shift's vans' seats (null: no van on it yet). */
  seats?: { capacity: number; taken: number } | null;
  /** Its place in line when the shift's vans are full. */
  waitlist?: { position: number; of: number } | null;
  /** Who else is on the van — faces only, never names. */
  coRiders?: Array<{ photoUrl: string | null }>;
}

/** What a rider looks for at the curb. */
export interface VanLook {
  make?: string | null;
  model?: string | null;
  color?: string | null;
  year?: number | null;
}

/** "White Ford Transit 2023" */
export function vanLookText(v: VanLook): string {
  return [v.color, v.make, v.model, v.year].filter((x) => x !== null && x !== undefined && x !== '').join(' ');
}

export type RiderSignal = 'OUTSIDE' | 'LATE';

/** A rider can be marked a no-show this long after the driver arrived. */
export const NO_SHOW_WAIT_MS = 3 * 60_000;

export interface RideRun {
  id: string;
  direction: RideDirection;
  serviceDate: string;
  departAt: string;
  status: RideRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  notes: string | null;
  van: { id: string; name: string; plate: string | null; capacity: number };
  driver: { userId: string; name: string };
  seats: { taken: number; capacity: number };
  rides: Ride[];
}

/* ----- The associate's Ride tab ------------------------------------------ */

/** A store's shift, as riders book it: "Morning 6:00 AM–2:00 PM". */
export interface StoreShiftWindow {
  label: string;
  startMinute: number;
  endMinute: number;
}

export interface RideStore {
  id: string;
  name: string;
  timezone: string;
  clientName: string;
  address: string | null;
  /** Its shifts — riders book by these (none: by time only). */
  windows?: StoreShiftWindow[];
}

export interface MyTransport {
  settings: TransportSettings;
  consent: { acceptedAt: string } | null;
  places: Array<{ id: string; label: string; address: string }>;
  stops: Array<{ id: string; name: string; address: string }>;
  stores: RideStore[];
  shifts: Array<{ id: string; startsAt: string; endsAt: string; position: string | null; locationId: string | null }>;
  rides: Ride[];
  /** Where they went last time — one-tap booking starts there. */
  defaultPickup:
    | { kind: 'stop'; stopId: string; label: string }
    | { kind: 'place'; placeId: string; label: string }
    | { kind: 'address'; address: string; lat: number | null; lng: number | null; label: string }
    | null;
  defaultStoreId: string | null;
  charges: {
    pendingCents: number;
    rides: number;
    noShows: number;
    nextPayday: { payDate: string; periodStart: string; periodEnd: string } | null;
  };
}

export const getMyTransport = () => apiFetch<MyTransport>('/transport/me');

export const giveRideConsent = () => apiFetch<{ ok: true }>('/transport/me/consent', { method: 'POST' });

export const addRidePlace = (body: { label: string; address: string; lat?: number; lng?: number }) =>
  apiFetch<{ place: { id: string; label: string; address: string } }>('/transport/me/places', { method: 'POST', body });

export const deleteRidePlace = (id: string) => apiFetch<void>(`/transport/me/places/${id}`, { method: 'DELETE' });

export interface BookRideInput {
  direction: RideDirection;
  locationId: string;
  stopId?: string;
  placeId?: string;
  address?: string;
  /** "Use where I am now" — the phone's own point for a new address. */
  lat?: number;
  lng?: number;
  /** An other time: arrive by / leave at. */
  targetAt?: string;
  /** Or by shift: the store shift and its day (YYYY-MM-DD). */
  windowLabel?: string;
  date?: string;
  note?: string;
  shiftId?: string;
}

export const bookRide = (body: BookRideInput) =>
  apiFetch<{ ride: Ride }>('/transport/me/rides', { method: 'POST', body });

/** One store shift, one way, one day — its seats and its line. */
export interface ShiftTrip {
  windowLabel: string;
  direction: RideDirection;
  targetAt: string;
  /** Outside the 10-hour cutoff and within 30 days. */
  bookable: boolean;
  vans: number;
  /** The seats its vans have — null while no driver has taken it yet. */
  seats: { capacity: number; taken: number } | null;
  /** Every van on it is full — a booking joins the waitlist. */
  full: boolean;
  /** Asking for a seat and not on a van yet (the line, when full). */
  waiting: number;
}

export const getShiftTrips = (locationId: string, date: string) =>
  apiFetch<{ windows: StoreShiftWindow[]; trips: ShiftTrip[] }>(
    `/transport/me/trips?locationId=${encodeURIComponent(locationId)}&date=${encodeURIComponent(date)}`,
  );

/** "I'm outside" / "running late" — to the driver, once the van is on its way. */
export const signalDriver = (rideId: string, kind: RiderSignal) =>
  apiFetch<{ ok: true }>(`/transport/me/rides/${rideId}/signal`, { method: 'POST', body: { kind } });

export const cancelMyRide = (id: string) =>
  apiFetch<{ ok: true }>(`/transport/me/rides/${id}/cancel`, { method: 'POST' });

/**
 * One candidate address, coordinates already attached.
 *
 * That attachment is the whole point of picking over typing: a booking
 * made from a suggestion is mappable by construction, so it can never
 * reach the driver's stop list as a row with no pin. `precision` is the
 * provider grading itself — 'approximate' means it interpolated along a
 * street rather than finding the building, which is when the rider is
 * asked to confirm the spot.
 */
export interface AddressSuggestion {
  label: string;
  address: string;
  lat: number;
  lng: number;
  precision: 'exact' | 'approximate';
}

/** Addresses matching what they have typed so far, biased toward the store. */
export const searchRideAddresses = (q: string, locationId?: string | null) =>
  apiFetch<{ results: AddressSuggestion[] }>(
    `/transport/me/ride-addresses?q=${encodeURIComponent(q)}${locationId ? `&locationId=${locationId}` : ''}`,
  );

/** The street address of the phone's position ("Use where I am now") —
 *  or `atStore` when the phone is standing at the store being booked to. */
export const whereAmI = (p: GeoPoint, locationId?: string | null) =>
  apiFetch<{ address: string | null; atStore: boolean }>(
    `/transport/me/where?lat=${p.lat}&lng=${p.lng}${locationId ? `&locationId=${locationId}` : ''}`,
  );

/* ----- The vans live -------------------------------------------------------- */

export interface VanPosition extends GeoPoint {
  heading: number | null;
  speedMps: number | null;
  at: string;
}

/** The rider's live ride: the van, their own pickup and destination only. */
/** The rider's next ride as a trip — from the moment they ask: its two
 *  ends always; the van, driver and run once a driver accepts; the van's
 *  position and the ETAs from 3 hours before it leaves. */
export interface MyLiveRide {
  rideId: string;
  direction: RideDirection;
  status: RideStatus;
  /** Null while it's still finding a driver. */
  runStatus: RideRunStatus | null;
  timezone: string;
  departAt: string | null;
  van: { name: string; plate: string | null } | null;
  driver: string | null;
  position: VanPosition | null;
  stale: boolean;
  pickup: { label: string; point: GeoPoint | null; scheduledAt: string | null; etaAt: string | null };
  destination: { label: string; point: GeoPoint | null; dueAt: string | null; etaAt: string | null };
  stopsBefore: number;
  lateMinutes: number;
  vanArrivedAt: string | null;
  riderSignal: RiderSignal | null;
}

export const getMyLiveRide = () => apiFetch<{ live: MyLiveRide | null }>('/transport/me/live');

/** A whole run on the map — the desk's and the driver's view. */
export interface RunMap {
  runId: string;
  status: RideRunStatus;
  direction: RideDirection;
  serviceDate: string;
  departAt: string;
  timezone: string;
  van: { id: string; name: string; plate: string | null; capacity: number };
  driver: { userId: string; name: string };
  position: VanPosition | null;
  stale: boolean;
  /** Where the van has been — [lng, lat] pairs. */
  trail: Array<[number, number]>;
  waypoints: Array<{ kind: 'pickup' | 'store' | 'drop'; point: GeoPoint | null; etaAt: string | null; label: string; rideIds: string[] }>;
  /** The run's stops, riders within a short walk grouped into one. */
  clusters?: RideCluster[];
  stores: Array<{ locationId: string; name: string; point: GeoPoint | null }>;
  late: Array<{ locationId: string; store: string; minutes: number }>;
  riders: Array<{
    rideId: string;
    name: string;
    status: RideStatus;
    pickupAt: string | null;
    point: GeoPoint | null;
    pickupEtaAt: string | null;
    dropEtaAt: string | null;
  }>;
}

export const getLiveBoard = (date?: string) =>
  apiFetch<{ date: string; generatedAt: string; runs: RunMap[] }>(`/transport/live${date ? `?date=${date}` : ''}`);

export const getDriverRunLive = (runId: string) => apiFetch<{ run: RunMap }>(`/transport/driver/runs/${runId}/live`);

/** One rider inside a stop. */
export interface ClusterRider {
  rideId: string;
  associateId: string;
  name: string;
  label: string;
  address: string;
  point: GeoPoint | null;
  /** Their own pin (or a named stop's), not an address lookup's guess. */
  pinned: boolean;
  status: RideStatus;
  photoUrl?: string;
}

/** A stop: everyone riding from one spot, in the order to work them. */
export interface RideCluster {
  key: string;
  label: string;
  address: string;
  point: GeoPoint | null;
  order: number;
  riders: ClusterRider[];
  /** How far apart the addresses in this stop are, in meters. */
  spreadM: number;
  mapped: boolean;
  etaAt?: string | null;
}

export interface TripMap {
  trip: {
    locationId: string;
    store: { name: string; clientName: string | null; address: string; point: GeoPoint | null; timezone: string };
    direction: RideDirection;
    windowLabel: string | null;
    serviceDate: string;
    targetAt: string | null;
    riders: number;
    requested: number;
    scheduled: number;
  };
  clusters: RideCluster[];
  unmapped: number;
}

/** One shift's pickups, grouped into stops and put in order. */
export const getTripMap = (q: { locationId: string; direction: RideDirection; date: string; windowLabel?: string | null }) => {
  const p = new URLSearchParams({ locationId: q.locationId, direction: q.direction, date: q.date });
  if (q.windowLabel) p.set('windowLabel', q.windowLabel);
  return apiFetch<TripMap>(`/transport/driver/trip-map?${p.toString()}`);
};

/** Where the van should actually stop for this rider — remembered. */
export const pinRide = (rideId: string, point: GeoPoint) =>
  apiFetch<{ ok: true; point: GeoPoint }>(`/transport/rides/${rideId}/pin`, { method: 'POST', body: point });

export const sendVanLocation = (
  runId: string,
  body: { lat: number; lng: number; heading?: number | null; speed?: number | null; accuracy?: number | null },
) => apiFetch<{ ok: true; skipped?: boolean }>(`/transport/driver/runs/${runId}/location`, { method: 'POST', body });

export const reportTransportIssue = (body: {
  category: TransportIssueCategory;
  body: string;
  rideId?: string;
  runId?: string;
}) => apiFetch<{ id: string }>('/transport/issues', { method: 'POST', body });

/* ----- The driver --------------------------------------------------------- */

export const getDriverRuns = () => apiFetch<{ today: string; runs: RideRun[] }>('/transport/driver/runs');

export const startDriverRun = (id: string) =>
  apiFetch<{ run: RideRun }>(`/transport/driver/runs/${id}/start`, { method: 'POST' });

export const completeDriverRun = (id: string) =>
  apiFetch<{ run: RideRun }>(`/transport/driver/runs/${id}/complete`, { method: 'POST' });

export const markBoarded = (rideId: string) =>
  apiFetch<{ ride: Ride }>(`/transport/driver/rides/${rideId}/board`, { method: 'POST' });

export const markNoShow = (rideId: string) =>
  apiFetch<{ ride: Ride }>(`/transport/driver/rides/${rideId}/no-show`, { method: 'POST' });

/** "Arrived" at a pickup — the riders there hear the van is here. */
export const driverArrived = (runId: string, rideIds: string[]) =>
  apiFetch<{ run: RideRun }>(`/transport/driver/runs/${runId}/arrived`, { method: 'POST', body: { rideIds } });

export const undoRideMark = (rideId: string) =>
  apiFetch<{ ride: Ride }>(`/transport/driver/rides/${rideId}/undo`, { method: 'POST' });

/* ----- The command center ------------------------------------------------- */

export interface TransportBoard {
  date: string;
  settings: TransportSettings;
  kpis: {
    booked: number;
    needsVan: number;
    scheduled: number;
    onBoard: number;
    completed: number;
    noShows: number;
    cancelled: number;
    vansOut: number;
    runs: number;
    openIssues: number;
  };
  rides: Ride[];
  runs: RideRun[];
  vans: Array<{ id: string; name: string; plate: string | null; capacity: number; driverUserId: string | null }>;
  drivers: Array<{
    userId: string;
    name: string;
    role: string;
    /** Driving is their trade — their main role, or a second one they
     *  hold. The transportation director drives only in a pinch. */
    drivesByTrade: boolean;
    phone: string | null;
  }>;
}

export const getTransportBoard = (date?: string) =>
  apiFetch<TransportBoard>(`/transport/board${date ? `?date=${date}` : ''}`);

export function searchRides(q: { from?: string; to?: string; status?: RideStatus; q?: string }) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const qs = p.toString();
  return apiFetch<{ rides: Ride[] }>(`/transport/rides${qs ? `?${qs}` : ''}`);
}

export const cancelRide = (id: string, reason: string) =>
  apiFetch<{ ok: true }>(`/transport/rides/${id}/cancel`, { method: 'POST', body: { reason } });

export const waiveRide = (id: string, reason: string) =>
  apiFetch<{ ok: true }>(`/transport/rides/${id}/waive`, { method: 'POST', body: { reason } });

export interface RunInput {
  vanId: string;
  driverUserId: string;
  direction: RideDirection;
  serviceDate: string;
  departAt: string;
  notes?: string;
  rides: Array<{ rideId: string; pickupAt: string }>;
}

export const createRun = (body: RunInput) => apiFetch<{ run: RideRun }>('/transport/runs', { method: 'POST', body });

export const updateRun = (
  id: string,
  body: Partial<Pick<RunInput, 'vanId' | 'driverUserId' | 'departAt' | 'rides'>> & { notes?: string | null },
) => apiFetch<{ run: RideRun }>(`/transport/runs/${id}`, { method: 'PATCH', body });

export const cancelRun = (id: string, reason: string) =>
  apiFetch<{ ok: true }>(`/transport/runs/${id}/cancel`, { method: 'POST', body: { reason } });

/**
 * Close out a run the driver never completed. Riders already marked on
 * board complete normally; anyone never marked is cancelled and charged
 * nothing, and comes back in `unmarkedCancelled` so the dispatcher can
 * see how many were left unaccounted for.
 */
export const closeRunFromDispatch = (id: string) =>
  apiFetch<{ boarded: number; unmarkedCancelled: number }>(
    `/transport/runs/${id}/complete`,
    { method: 'POST' },
  );

export interface Van {
  id: string;
  name: string;
  plate: string | null;
  capacity: number;
  isActive: boolean;
  notes: string | null;
  make: string | null;
  model: string | null;
  color: string | null;
  year: number | null;
  look: string;
  /** The van's driver — they accept seat requests in it. */
  driver: { userId: string; name: string; associateId: string | null; phone: string | null } | null;
}

export interface VanInput {
  name: string;
  plate?: string | null;
  capacity: number;
  notes?: string | null;
  make?: string | null;
  model?: string | null;
  color?: string | null;
  year?: number | null;
  isActive?: boolean;
  /** null takes the van off its driver. */
  driverUserId?: string | null;
}

export const listVans = () => apiFetch<{ vans: Van[] }>('/transport/vans');
export const createVan = (body: VanInput) => apiFetch<{ van: Van }>('/transport/vans', { method: 'POST', body });
export const updateVan = (id: string, body: Partial<VanInput>) =>
  apiFetch<{ van: Van }>(`/transport/vans/${id}`, { method: 'PATCH', body });

/** The fleet by the numbers, for a date range. */
export interface FleetVan extends Van {
  stats: {
    revenueCents: number;
    waivedCents: number;
    runs: number;
    riders: number;
    noShows: number;
    seatFill: number | null;
    miles: number;
    daily: Array<{ date: string; cents: number }>;
  };
  now: { onTheRoad: boolean; driver: string; lastSeenAt: string | null; position: GeoPoint | null } | null;
}

export const getFleet = (from: string, to: string) =>
  apiFetch<{ from: string; to: string; vans: FleetVan[] }>(`/transport/fleet?from=${from}&to=${to}`);

/** Put a seat every driver declined back in front of them. */
export const reofferRide = (id: string) => apiFetch<{ ok: true }>(`/transport/rides/${id}/reoffer`, { method: 'POST' });

/* ----- Seat requests (drivers) and profiles ---------------------------------- */

export interface SeatRequest extends Ride {
  /** It fits a run the driver already has. */
  fits: { runId: string; departAt: string } | null;
}

export const getSeatRequests = () =>
  apiFetch<{ van: { id: string; name: string; plate: string | null; capacity: number; look: string } | null; requests: SeatRequest[] }>(
    '/transport/driver/requests',
  );
/** The driver's week, like a schedule. */
export interface DriverWeekRun {
  id: string;
  status: RideRunStatus;
  direction: RideDirection;
  serviceDate: string;
  departAt: string;
  timezone: string;
  /** The store shift it serves ("Morning"); null for other times. */
  shift: string | null;
  stores: string[];
  /** The store whose shift map this run opens. */
  storeId?: string | null;
  van: { name: string; plate: string | null; capacity: number };
  seats: { taken: number; capacity: number };
  riders: Array<{
    rideId: string;
    associateId: string;
    name: string;
    photoUrl: string | null;
    pickupAt: string | null;
    place: string;
    status: RideStatus;
  }>;
}

export interface DriverWeek {
  from: string;
  to: string;
  van: { name: string; plate: string | null; capacity: number } | null;
  runs: DriverWeekRun[];
  /** Seats still asked for, by shift — what's there to take. */
  asking: Array<{
    serviceDate: string;
    direction: RideDirection;
    windowLabel: string | null;
    targetAt: string;
    store: { id: string; name: string; timezone: string };
    count: number;
  }>;
}

export const getDriverWeek = (from: string, days = 7) =>
  apiFetch<DriverWeek>(`/transport/driver/schedule?from=${from}&days=${days}`);

export const acceptSeat = (rideId: string) =>
  apiFetch<{ run: RideRun }>(`/transport/driver/requests/${rideId}/accept`, { method: 'POST' });
export const declineSeat = (rideId: string, reason?: string) =>
  apiFetch<{ ok: true }>(`/transport/driver/requests/${rideId}/decline`, { method: 'POST', body: reason ? { reason } : {} });

export interface RideCrew {
  van: VanLook & { name: string; plate: string | null; capacity: number; look: string };
  driver: { name: string; associateId: string | null; since: string; trips: number; riders: number };
}
export const getMyCrew = (rideId: string) => apiFetch<{ crew: RideCrew | null }>(`/transport/me/rides/${rideId}/crew`);

export interface RiderProfile {
  associateId: string;
  name: string;
  phone: string | null;
  since: string;
  rides: number;
  noShows: number;
  cancelled: number;
}
export const getRiderProfile = (associateId: string) => apiFetch<{ rider: RiderProfile }>(`/transport/riders/${associateId}`);

export interface TransportStop {
  id: string;
  name: string;
  address: string;
  notes: string | null;
  isActive: boolean;
}

export const listStops = () => apiFetch<{ stops: TransportStop[] }>('/transport/stops');
export const createStop = (body: { name: string; address: string; notes?: string | null }) =>
  apiFetch<{ stop: TransportStop }>('/transport/stops', { method: 'POST', body });
export const updateStop = (id: string, body: Partial<Omit<TransportStop, 'id'>>) =>
  apiFetch<{ stop: TransportStop }>(`/transport/stops/${id}`, { method: 'PATCH', body });

export interface TransportIssue {
  id: string;
  category: TransportIssueCategory;
  body: string;
  status: TransportIssueStatus;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  reportedBy: { userId: string; name: string; role: string };
  ride: Ride | null;
  run: { id: string; serviceDate: string; departAt: string; van: string } | null;
}

export const listTransportIssues = (status?: TransportIssueStatus) =>
  apiFetch<{ issues: TransportIssue[] }>(`/transport/issues${status ? `?status=${status}` : ''}`);

export const updateTransportIssue = (id: string, body: { status: TransportIssueStatus; resolution?: string }) =>
  apiFetch<{ ok: true }>(`/transport/issues/${id}`, { method: 'PATCH', body });

export interface TransportChargeRow {
  associateId: string;
  name: string;
  rides: number;
  noShows: number;
  owedCents: number;
  takenCents: number;
  waivedCents: number;
}

export const getTransportCharges = (from: string, to: string) =>
  apiFetch<{
    from: string;
    to: string;
    rows: TransportChargeRow[];
    totals: Omit<TransportChargeRow, 'associateId' | 'name'>;
  }>(`/transport/charges?from=${from}&to=${to}`);

export const getTransportSettings = () => apiFetch<{ settings: TransportSettings }>('/transport/settings');
export const saveTransportSettings = (body: TransportSettings) =>
  apiFetch<{ settings: TransportSettings }>('/transport/settings', { method: 'PUT', body });

/* ----- The store supervisors' heads-up ----------------------------------- */

export interface VanArrival {
  rideId: string;
  associateId: string;
  name: string;
  store: { id: string; name: string };
  arriveBy: string;
  /** When the van actually gets them here (a van on the road). */
  etaAt: string | null;
  lateMinutes: number;
  status: RideStatus;
  van: string | null;
  hasShift: boolean;
}

export const getVanArrivals = (clientId?: string) =>
  apiFetch<{ arrivals: VanArrival[] }>(`/transport/arrivals${clientId ? `?clientId=${clientId}` : ''}`);
