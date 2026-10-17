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
  /** Planned rides book this far ahead. */
  cutoffHours: number;
  /** Inside the cutoff, a seat can still be requested down to this many
   *  minutes before its time; 0 = never. */
  shortNoticeMinutes: number;
  /** Shown when a ride can't be requested in time. */
  dispatchPhone: string | null;
  /** Drivers' hours of service and the pre-trip switch. Older answers may omit them. */
  driverMaxHoursPerDay?: number;
  driverMinRestHours?: number;
  preTripRequired?: boolean;
  driverShiftLocationId?: string | null;
}

/** How a ride at a given time can be requested right now. */
export type RideNotice = 'planned' | 'short_notice' | 'closed' | 'too_far';

export interface RidePlace {
  id: string;
  label: string;
  address: string;
  lat: number | null;
  lng: number | null;
  /** False for a place saved before the picker that the lookup never placed — it needs a pin before it books. */
  located: boolean;
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
  /** Requested inside the planning cutoff — a driver has to take it. */
  shortNotice?: boolean;
  pickup:
    | { kind: 'stop'; id: string; name: string; address: string }
    | { kind: 'address'; id: null; name: null; address: string };
  /** The home end's coordinates, when known. */
  point: GeoPoint | null;
  store: { id: string; name: string; timezone: string; clientId: string | null; clientName: string };
  rider: { associateId: string; name: string; phone: string | null };
  pickupOrder: number | null;
  pickupAt: string | null;
  run: {
    id: string;
    status: RideRunStatus;
    departAt: string;
    van: VanLook & { id: string; name: string; plate: string | null };
    driver: { userId: string; name: string; associateId: string | null; photoUrl?: string | null };
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
  /** The walk around the van before this run leaves. Older answers omit it. */
  preTrip?: { passed: boolean; at: string } | null;
  /** The safety toolkit's stamps. Older answers omit it. */
  safety?: RunSafety;
}

export interface RunSafety {
  sosAt: string | null;
  sosAckAt: string | null;
  /** The driver was asked "everything OK?" and hasn't answered. */
  promptedAt: string | null;
  escalatedAt: string | null;
  sosNote?: string | null;
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
  /** One of the stores they are placed at — listed first, the default. */
  mine?: boolean;
  /** Its shifts — riders book by these (none: by time only). */
  windows?: StoreShiftWindow[];
}

/** Brief 1A-3: the fare and no-show fee, effective-dated. */
export interface RideRate {
  id: string;
  fareCents: number;
  noShowFeeCents: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * Brief 1A-3: the signed written authorization for ride charges. `current`
 * means signed, not withdrawn, on the current words and at the rate in
 * force — the only state in which a ride can be booked or charged.
 */
export interface RideAuthorizationStatus {
  current: boolean;
  signedAt: string | null;
  signedName: string | null;
  version: number | null;
  fareCents: number | null;
  noShowFeeCents: number | null;
  withdrawnAt: string | null;
  documentId: string | null;
  /** Why it is not current, in words. */
  reason: string | null;
  /** The words to sign now, in the rider's language, with the rate in force. */
  agreement: { title: string; body: string; version: number; lang: 'en' | 'es' | 'tr'; fareCents: number; noShowFeeCents: number } | null;
}

export interface MyTransport {
  settings: TransportSettings;
  /** Older shape: non-null only while the authorization is current. */
  consent: { acceptedAt: string } | null;
  authorization?: RideAuthorizationStatus;
  places: RidePlace[];
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
  /** The home address from onboarding, when it isn't a saved place yet — one tap, no typing. */
  profileAddress?: { address: string } | null;
  charges: {
    pendingCents: number;
    rides: number;
    noShows: number;
    nextPayday: { payDate: string; periodStart: string; periodEnd: string } | null;
  };
}

export const getMyTransport = () => apiFetch<MyTransport>('/transport/me');

/** Sign the authorization by typing one's name under the words shown. */
export const signRideAuthorization = (typedName: string, version?: number) =>
  apiFetch<{ authorization: RideAuthorizationStatus }>('/transport/me/authorization', { method: 'POST', body: { typedName, version } });
/** Withdraw: no new ride is booked or charged; rides already taken are still owed. */
export const withdrawRideAuthorization = () =>
  apiFetch<{ authorization: RideAuthorizationStatus }>('/transport/me/authorization', { method: 'DELETE' });

export const addRidePlace = (body: { label: string; address: string; lat?: number; lng?: number }) =>
  apiFetch<{ place: RidePlace }>('/transport/me/places', { method: 'POST', body });

export const deleteRidePlace = (id: string) => apiFetch<void>(`/transport/me/places/${id}`, { method: 'DELETE' });

/** The pin for a saved address that never had one. */
export const updateRidePlace = (id: string, point: GeoPoint) =>
  apiFetch<{ place: RidePlace }>(`/transport/me/places/${id}`, { method: 'PATCH', body: point });

/** Where to open the map for a saved address with no pin: a fresh lookup, else the store. */
export const locateRidePlace = (id: string, locationId?: string | null) =>
  apiFetch<{ point: GeoPoint | null; center: GeoPoint | null }>(
    `/transport/me/places/${id}/locate${locationId ? `?locationId=${locationId}` : ''}`,
  );

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
  /** How this leg can be requested right now; bookable = planned or short notice. */
  notice?: RideNotice;
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
  apiFetch<{
    results: AddressSuggestion[];
    unavailable?: boolean;
    /** When nothing matched: where a pin for the typed address should start (the street, else the store). */
    center?: (GeoPoint & { approximate: boolean }) | null;
  }>(
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
  /** The safety toolkit's stamps. Older answers omit it. */
  safety?: RunSafety;
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
  /** Parked: not planned, not dispatched. Older answers omit it. */
  outOfService?: { since: string; reason: string | null } | null;
  /** Papers lapsing inside 30 days, or lapsed. */
  papersDue?: Array<{ label: string; expiresAt: string; expired: boolean }>;
  /** The van's driver — they accept seat requests in it. */
  driver: { userId: string; name: string; associateId: string | null; photoUrl?: string | null; phone: string | null } | null;
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
  apiFetch<{
    van: { id: string; name: string; plate: string | null; capacity: number; look: string } | null;
    requests: SeatRequest[];
    /** The clients this driver is approved for — none, and the list is empty on purpose. */
    clients?: { all: boolean; approved: number; pending: number };
  }>('/transport/driver/requests');

/* ----- Which clients a driver picks up for ----------------------------------- */

export type DriverAccessStatus = 'REQUESTED' | 'APPROVED' | 'DENIED';

export interface DriverAccessState {
  id: string;
  status: DriverAccessStatus;
  note: string | null;
  decisionNote: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

/** The driver's view: every active client, and where they stand on each. */
export interface DriverClients {
  /** The "all clients" row, when they asked for or were granted everything. */
  all: DriverAccessState | null;
  clients: Array<{ id: string; name: string; access: DriverAccessState | null }>;
  approved: number;
  pending: number;
}

export const getDriverClients = () => apiFetch<DriverClients>('/transport/driver/clients');
export const requestDriverClients = (body: { all?: boolean; clientIds?: string[]; note?: string }) =>
  apiFetch<DriverClients>('/transport/driver/clients/request', { method: 'POST', body });
/** `key` is a client id, or "all". */
export const dropDriverClient = (key: string) =>
  apiFetch<DriverClients>(`/transport/driver/clients/${key}`, { method: 'DELETE' });

/** The desk's view: one row per driver × client (null client = all). */
export interface DriverAccessRow {
  id: string;
  driver: { userId: string; name: string };
  client: { id: string; name: string } | null;
  status: DriverAccessStatus;
  note: string | null;
  decisionNote: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export const getDriverAccess = () =>
  apiFetch<{ rows: DriverAccessRow[]; clients: Array<{ id: string; name: string }>; drivers: Array<{ userId: string; name: string }> }>(
    '/transport/driver-access',
  );
export const decideDriverAccess = (id: string, decision: 'APPROVED' | 'DENIED', note?: string) =>
  apiFetch<{ row: DriverAccessRow }>(`/transport/driver-access/${id}/decide`, { method: 'POST', body: { decision, ...(note ? { note } : {}) } });
export const grantDriverAccess = (body: { driverUserId: string; all?: boolean; clientIds?: string[] }) =>
  apiFetch<DriverClients>('/transport/driver-access/grant', { method: 'POST', body });
export const revokeDriverAccess = (id: string) =>
  apiFetch<{ ok: true }>(`/transport/driver-access/${id}`, { method: 'DELETE' });
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
  driver: { name: string; associateId: string | null; photoUrl?: string | null; since: string; trips: number; riders: number };
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

export type RideAuthorizationState = 'current' | 'none' | 'legacy' | 'withdrawn' | 'outdated';

export interface TransportChargeRow {
  associateId: string;
  name: string;
  rides: number;
  noShows: number;
  owedCents: number;
  takenCents: number;
  waivedCents: number;
  /** Charges on file with no signed authorization — never deducted. */
  unauthorizedCents: number;
  /** Held back by the minimum-wage guard, carried to a later check. */
  deferredCents: number;
  authorization: RideAuthorizationState;
}

export const getTransportCharges = (from: string, to: string) =>
  apiFetch<{
    from: string;
    to: string;
    rows: TransportChargeRow[];
    totals: Omit<TransportChargeRow, 'associateId' | 'name' | 'authorization'>;
    rate: RideRate | null;
  }>(`/transport/charges?from=${from}&to=${to}`);

/** The server's CSV of the same report. */
export const transportChargesCsvUrl = (from: string, to: string) => `/api/transport/charges?from=${from}&to=${to}&format=csv`;

export interface RideAuthorizationRow {
  associateId: string;
  name: string;
  status: RideAuthorizationState;
  reason: string | null;
  signedAt: string | null;
  signedName: string | null;
  version: number | null;
  fareCents: number | null;
  noShowFeeCents: number | null;
  withdrawnAt: string | null;
  documentId: string | null;
}

export const getRideAuthorizations = () =>
  apiFetch<{ rows: RideAuthorizationRow[]; rate: RideRate | null; version: number }>('/transport/authorizations');

export interface GeocoderStatus {
  primary: 'mapbox' | 'nominatim' | 'off';
  fallback: 'nominatim' | null;
}

export const getTransportSettings = () =>
  apiFetch<{ settings: TransportSettings; rates?: RideRate[]; geocoder?: GeocoderStatus }>('/transport/settings');
/** `effectiveFrom` (YYYY-MM-DD) dates a fare/fee change; a change asks every rider to sign again. */
export const saveTransportSettings = (body: TransportSettings & { effectiveFrom?: string }) =>
  apiFetch<{ settings: TransportSettings; rates?: RideRate[] }>('/transport/settings', { method: 'PUT', body });

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
  /** The van finished and dropped them: in the building. */
  droppedAt?: string | null;
}

export const getVanArrivals = (clientId?: string) =>
  apiFetch<{ arrivals: VanArrival[] }>(`/transport/arrivals${clientId ? `?clientId=${clientId}` : ''}`);

/* ===== The driver and fleet pack (routes/transportOps) ====================== */

/* ----- The driver as a worker ------------------------------------------- */

export type NavApp = 'GOOGLE' | 'APPLE' | 'WAZE';

export interface DriverProfile {
  navApp: NavApp;
  licenceNumber: string | null;
  licenceState: string | null;
  licenceClass: string | null;
  licenceExpiresAt: string | null;
  dotMedicalRequired: boolean;
  dotMedicalExpiresAt: string | null;
  mvrCheckedAt: string | null;
  trainingCompletedAt?: string | null;
  trainingExpiresAt?: string | null;
  notes: string | null;
}

export type CredentialKey = 'licence' | 'dot' | 'training' | 'mvr';

export interface CredentialStatus {
  ok: boolean;
  problems: Array<{ key: CredentialKey; label: string; expiresAt: string | null; expired: boolean }>;
  dueSoon: Array<{ key: CredentialKey; label: string; expiresAt: string }>;
}

export const getDriverProfile = () =>
  apiFetch<{ profile: DriverProfile; credentials: CredentialStatus; associateId: string | null }>('/transport/driver/profile');
export const setDriverNavApp = (navApp: NavApp) =>
  apiFetch<{ profile: DriverProfile; credentials: CredentialStatus }>('/transport/driver/profile', { method: 'PATCH', body: { navApp } });

export interface DriverShift {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  notes?: string | null;
  today?: boolean;
}

export interface DriverToday {
  date: string;
  associateId: string | null;
  runs: { total: number; done: number; active: number };
  hours: { worked: number; driven: number; onClock: boolean };
  shifts: DriverShift[];
  earnings: {
    hourlyRate: number;
    earnedSoFar: number;
    workedHours: number;
    projectedWeek: number;
    currentShiftEarned: number | null;
    onClock: boolean;
    weekStart: string;
    weekEnd: string;
  } | null;
  /** Null until transportation keeps a record for this driver. */
  credentials: CredentialStatus | null;
  hoursOfService: { maxPerDay: number; minRest: number };
  preTripRequired: boolean;
}

export const getDriverToday = () => apiFetch<DriverToday>('/transport/driver/today');
export const driverClockIn = () => apiFetch<{ entry: { id: string; clockInAt: string } }>('/transport/driver/clock-in', { method: 'POST' });
export const driverClockOut = () => apiFetch<{ entry: { id: string; clockInAt: string; clockOutAt: string } }>('/transport/driver/clock-out', { method: 'POST' });
export interface DriverTimeEntry {
  id: string;
  clockInAt: string;
  clockOutAt: string | null;
  status: string;
  hours: number | null;
}
export const getDriverTime = () => apiFetch<{ entries: DriverTimeEntry[] }>('/transport/driver/time');
export const getDriverShifts = (from?: string, days = 14) =>
  apiFetch<{ associateId: string | null; shifts: DriverShift[] }>(`/transport/driver/shifts?days=${days}${from ? `&from=${from}` : ''}`);

/** Turn-by-turn, in the app the driver likes, to one stop. */
export function navigationUrl(app: NavApp, to: { point?: GeoPoint | null; address: string }): string {
  const q = to.point ? `${to.point.lat},${to.point.lng}` : to.address;
  if (app === 'WAZE') return to.point ? `https://waze.com/ul?ll=${to.point.lat},${to.point.lng}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(to.address)}&navigate=yes`;
  if (app === 'APPLE') return `https://maps.apple.com/?daddr=${encodeURIComponent(q)}&dirflg=d`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}&travelmode=driving`;
}

/* ----- The pre-trip check ------------------------------------------------- */

export interface PreTripItemDef {
  key: string;
  label: string;
  safety: boolean;
}

export interface PreTripAnswer {
  key: string;
  ok: boolean;
  note?: string | null;
}

export interface PreTripCheck {
  id: string;
  passed: boolean;
  items: Array<PreTripAnswer & { label: string; safety: boolean }>;
  failed: string[];
  odometerMiles: number | null;
  photoUrl: string | null;
  notes: string | null;
  at: string;
  driverUserId: string;
  driver?: string;
}

export const getPreTrip = (runId: string) =>
  apiFetch<{ required: boolean; items: PreTripItemDef[]; check: PreTripCheck | null }>(`/transport/driver/runs/${runId}/pre-trip`);
export const submitPreTrip = (runId: string, body: { items: PreTripAnswer[]; odometerMiles?: number | null; notes?: string | null; photoKey?: string | null }) =>
  apiFetch<{ check: PreTripCheck; passed: boolean; failedSafety: Array<{ key: string; label: string }> }>(`/transport/driver/runs/${runId}/pre-trip`, { method: 'POST', body });

/** A photo for a check or an incident — multipart, so it skips apiFetch's JSON. */
export async function uploadTransportPhoto(file: File): Promise<{ key: string; url: string }> {
  const fd = new FormData();
  fd.append('photo', file);
  const res = await fetch('/api/transport/photos', { method: 'POST', credentials: 'include', body: fd });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return (await res.json()) as { key: string; url: string };
}

/* ----- The safety toolkit -------------------------------------------------- */

export const raiseSos = (runId: string, body: { note?: string | null; lat?: number | null; lng?: number | null } = {}) =>
  apiFetch<{ ok: true }>(`/transport/driver/runs/${runId}/sos`, { method: 'POST', body });
export const driverOk = (runId: string) => apiFetch<{ ok: true }>(`/transport/driver/runs/${runId}/ok`, { method: 'POST' });
export const shareTrip = (runId: string) => apiFetch<{ url: string; token: string; expiresAt: string }>(`/transport/driver/runs/${runId}/share`);
export const ackSos = (runId: string) => apiFetch<{ ok: true }>(`/transport/runs/${runId}/sos/ack`, { method: 'POST' });

export interface PublicTrip {
  status: RideRunStatus;
  van: { name: string; plate: string | null };
  driver: string | null;
  position: VanPosition | null;
  stale: boolean;
  next: { kind: 'pickup' | 'store' | 'drop'; label: string; etaAt: string | null } | null;
  stopsLeft: number;
  endedAt: string | null;
  generatedAt: string;
}

export const getPublicTrip = (token: string) => apiFetch<{ trip: PublicTrip }>(`/transport/track/${token}`);

/* ----- Incidents ------------------------------------------------------------- */

export type TransportIncidentKind = 'COLLISION' | 'INJURY' | 'BREAKDOWN' | 'NEAR_MISS' | 'PROPERTY_DAMAGE' | 'OTHER';
export type TransportIncidentStatus = 'OPEN' | 'REVIEWED' | 'CLOSED';

export interface IncidentParty {
  name: string;
  phone?: string | null;
  plate?: string | null;
  insurer?: string | null;
  note?: string | null;
}

export interface TransportIncident {
  id: string;
  kind: TransportIncidentKind;
  status: TransportIncidentStatus;
  occurredAt: string;
  point: GeoPoint | null;
  description: string;
  injuries: boolean;
  injuredAssociateIds: string[];
  parties: IncidentParty[];
  policeReportNumber: string | null;
  photos: string[];
  oshaIncidentIds: string[];
  vanParked: boolean;
  reviewNote: string | null;
  reviewedAt: string | null;
  reportedBy: { userId: string; name: string };
  van: { id: string; name: string; plate: string | null } | null;
  run: { id: string; serviceDate: string; departAt: string; direction: RideDirection } | null;
  createdAt: string;
}

export interface IncidentInput {
  kind: TransportIncidentKind;
  runId?: string | null;
  vanId?: string | null;
  occurredAt?: string;
  lat?: number | null;
  lng?: number | null;
  description: string;
  injuries?: boolean;
  injuredAssociateIds?: string[];
  parties?: IncidentParty[];
  policeReportNumber?: string | null;
  photoKeys?: string[];
  parkVan?: boolean;
}

export const reportIncident = (body: IncidentInput) => apiFetch<{ incident: TransportIncident }>('/transport/incidents', { method: 'POST', body });
export const listIncidents = (q: { status?: TransportIncidentStatus; vanId?: string } = {}) => {
  const p = new URLSearchParams();
  if (q.status) p.set('status', q.status);
  if (q.vanId) p.set('vanId', q.vanId);
  const qs = p.toString();
  return apiFetch<{ incidents: TransportIncident[] }>(`/transport/incidents${qs ? `?${qs}` : ''}`);
};
export const reviewIncident = (id: string, body: { status?: TransportIncidentStatus; reviewNote?: string | null }) =>
  apiFetch<{ incident: TransportIncident }>(`/transport/incidents/${id}`, { method: 'PATCH', body });

/* ----- The rider's thumb ----------------------------------------------------- */

export type FeedbackReason = 'GREAT' | 'LATE' | 'DRIVING' | 'VEHICLE' | 'CONDUCT' | 'ROUTE' | 'OTHER';

export interface PendingFeedbackRide {
  rideId: string;
  direction: RideDirection;
  completedAt: string | null;
  store: string;
  timezone: string;
  van: string | null;
  driver: string | null;
}

export const getPendingFeedback = () => apiFetch<{ rides: PendingFeedbackRide[]; reasons: FeedbackReason[] }>('/transport/me/feedback/pending');
export const sendRideFeedback = (rideId: string, body: { thumbsUp: boolean; reason?: FeedbackReason | null; note?: string | null }) =>
  apiFetch<{ feedback: { id: string; thumbsUp: boolean; reason: string | null; note: string | null } }>(`/transport/me/rides/${rideId}/feedback`, { method: 'POST', body });

export interface FeedbackTally {
  up: number;
  down: number;
  reasons: Record<string, number>;
  score: number | null;
}

export interface FeedbackTrend {
  from: string;
  to: string;
  total: FeedbackTally;
  byDriver: Array<FeedbackTally & { userId: string; name: string }>;
  byRoute: Array<FeedbackTally & { locationId: string; store: string; direction: RideDirection }>;
  notes: Array<{ at: string; thumbsUp: boolean; reason: string | null; note: string | null; store: string; driver: string | null }>;
}

export const getFeedbackTrend = (from: string, to: string) => apiFetch<FeedbackTrend>(`/transport/feedback?from=${from}&to=${to}`);

/* ----- Standing bookings ------------------------------------------------------ */

export interface RideSeries {
  id: string;
  direction: RideDirection;
  store: { id: string; name: string; timezone: string };
  pickup: { kind: 'stop'; id: string; name: string } | { kind: 'address'; id: null; name: null; address: string };
  windowLabel: string | null;
  timeOfDay: string | null;
  daysOfWeek: number[];
  startsOn: string;
  endsOn: string | null;
  note: string | null;
  active: boolean;
  bookedThrough: string | null;
  rides: number;
}

export interface SeriesInput {
  direction: RideDirection;
  locationId: string;
  stopId?: string;
  placeId?: string;
  address?: string;
  lat?: number;
  lng?: number;
  windowLabel?: string;
  timeOfDay?: string;
  daysOfWeek: number[];
  startsOn: string;
  endsOn?: string | null;
  note?: string | null;
}

export const listMySeries = () => apiFetch<{ series: RideSeries[] }>('/transport/me/series');
export const createSeries = (body: SeriesInput) =>
  apiFetch<{ series: RideSeries; booked: number; skipped: number }>('/transport/me/series', { method: 'POST', body });
export const cancelSeries = (id: string) => apiFetch<void>(`/transport/me/series/${id}`, { method: 'DELETE' });

/* ----- The fleet record --------------------------------------------------------- */

export type VanServiceKind = 'FUEL' | 'OIL_CHANGE' | 'TIRES' | 'BRAKES' | 'INSPECTION' | 'REPAIR' | 'CLEANING' | 'OTHER';

export interface VanDocument {
  label: string;
  expiresAt: string | null;
  expired: boolean;
  dueSoon: boolean;
}

export interface VanRecord {
  id: string;
  name: string;
  plate: string | null;
  vin: string | null;
  odometerMiles: number | null;
  registrationExpiresAt: string | null;
  insuranceExpiresAt: string | null;
  inspectionDueAt: string | null;
  outOfService: { since: string; reason: string | null } | null;
  documents: VanDocument[];
}

export interface VanServiceEntry {
  id: string;
  kind: VanServiceKind;
  occurredAt: string | null;
  odometerMiles: number | null;
  costCents: number;
  vendor: string | null;
  notes: string | null;
}

export const getVanRecord = (vanId: string) =>
  apiFetch<{ record: VanRecord; serviceLog: VanServiceEntry[]; checks: PreTripCheck[]; incidents: TransportIncident[] }>(`/transport/vans/${vanId}/record`);
export const updateVanRecord = (
  vanId: string,
  body: Partial<Pick<VanRecord, 'vin' | 'registrationExpiresAt' | 'insuranceExpiresAt' | 'inspectionDueAt' | 'odometerMiles'>> & { outOfService?: { reason: string } | null },
) => apiFetch<{ record: VanRecord }>(`/transport/vans/${vanId}/record`, { method: 'PATCH', body });
export const addVanService = (vanId: string, body: { kind: VanServiceKind; occurredAt: string; odometerMiles?: number | null; costCents: number; vendor?: string | null; notes?: string | null }) =>
  apiFetch<{ entry: VanServiceEntry }>(`/transport/vans/${vanId}/service`, { method: 'POST', body });
export const removeVanService = (vanId: string, entryId: string) => apiFetch<void>(`/transport/vans/${vanId}/service/${entryId}`, { method: 'DELETE' });

/* ----- The desk's drivers ------------------------------------------------------- */

export interface DeskDriver {
  userId: string;
  name: string;
  role: string;
  drivesByTrade: boolean;
  phone: string | null;
  associateId: string | null;
  photoUrl: string | null;
  van: { id: string; name: string; plate: string | null; outOfService: boolean } | null;
  profile: DriverProfile;
  credentials: CredentialStatus;
  today: Array<{ id: string; startsAt: string; endsAt: string }>;
}

export const listDrivers = () => apiFetch<{ drivers: DeskDriver[] }>('/transport/drivers');
export const updateDriverProfile = (userId: string, body: Partial<DriverProfile>) =>
  apiFetch<{ profile: DriverProfile; credentials: CredentialStatus }>(`/transport/drivers/${userId}/profile`, { method: 'PATCH', body });

export interface DeskDriverShift {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  notes: string | null;
  driver: { userId: string; name: string; associateId: string | null } | null;
}

export const listDriverShifts = (from: string, to: string) => apiFetch<{ shifts: DeskDriverShift[] }>(`/transport/driver-shifts?from=${from}&to=${to}`);
export const createDriverShift = (body: { driverUserId: string; startsAt: string; endsAt: string; notes?: string | null }) =>
  apiFetch<{ shift: DeskDriverShift }>('/transport/driver-shifts', { method: 'POST', body });
export const deleteDriverShift = (id: string) => apiFetch<void>(`/transport/driver-shifts/${id}`, { method: 'DELETE' });

/* ----- The director's numbers ---------------------------------------------------- */

export interface NeedsYouItem {
  key: string;
  label: string;
  count: number;
  path: string;
  tone: 'alert' | 'warning' | 'info';
}

export const getTransportNeedsYou = () => apiFetch<{ total: number; items: NeedsYouItem[] }>('/transport/needs-you');

export interface TransportExpiration {
  kind: 'van' | 'driver';
  id: string;
  name: string;
  document: string;
  expiresAt: string;
  daysUntilExpiry: number;
}

export const getTransportExpiring = (days = 60) => apiFetch<{ items: TransportExpiration[] }>(`/transport/expiring?days=${days}`);

export interface CostRow {
  clientId: string | null;
  client: string;
  runs: number;
  seats: number;
  noShows: number;
  faresCents: number;
  driverCents: number;
  fuelCents: number;
  maintenanceCents: number;
  costCents: number;
  netCents: number;
  costPerSeatCents: number | null;
  farePerSeatCents: number | null;
}

export const getTransportCosts = (from: string, to: string) =>
  apiFetch<{ from: string; to: string; rows: CostRow[]; totals: CostRow; note: string }>(`/transport/costs?from=${from}&to=${to}`);
