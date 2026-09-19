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
  note: string | null;
  pickup:
    | { kind: 'stop'; id: string; name: string; address: string }
    | { kind: 'address'; id: null; name: null; address: string };
  store: { id: string; name: string; timezone: string; clientId: string; clientName: string };
  rider: { associateId: string; name: string; phone: string | null };
  pickupOrder: number | null;
  pickupAt: string | null;
  run: {
    id: string;
    status: RideRunStatus;
    departAt: string;
    van: { id: string; name: string; plate: string | null };
    driver: { userId: string; name: string };
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
  createdAt: string;
}

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

export interface RideStore {
  id: string;
  name: string;
  timezone: string;
  clientName: string;
  address: string | null;
}

export interface MyTransport {
  settings: TransportSettings;
  consent: { acceptedAt: string } | null;
  places: Array<{ id: string; label: string; address: string }>;
  stops: Array<{ id: string; name: string; address: string }>;
  stores: RideStore[];
  shifts: Array<{ id: string; startsAt: string; endsAt: string; position: string | null; locationId: string | null }>;
  rides: Ride[];
  charges: {
    pendingCents: number;
    rides: number;
    noShows: number;
    nextPayday: { payDate: string; periodStart: string; periodEnd: string } | null;
  };
}

export const getMyTransport = () => apiFetch<MyTransport>('/transport/me');

export const giveRideConsent = () => apiFetch<{ ok: true }>('/transport/me/consent', { method: 'POST' });

export const addRidePlace = (body: { label: string; address: string }) =>
  apiFetch<{ place: { id: string; label: string; address: string } }>('/transport/me/places', { method: 'POST', body });

export const deleteRidePlace = (id: string) => apiFetch<void>(`/transport/me/places/${id}`, { method: 'DELETE' });

export interface BookRideInput {
  direction: RideDirection;
  locationId: string;
  stopId?: string;
  placeId?: string;
  address?: string;
  targetAt: string;
  note?: string;
  shiftId?: string;
}

export const bookRide = (body: BookRideInput) =>
  apiFetch<{ ride: Ride }>('/transport/me/rides', { method: 'POST', body });

export const cancelMyRide = (id: string) =>
  apiFetch<{ ok: true }>(`/transport/me/rides/${id}/cancel`, { method: 'POST' });

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
  vans: Array<{ id: string; name: string; plate: string | null; capacity: number }>;
  drivers: Array<{ userId: string; name: string; role: string }>;
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

export interface Van {
  id: string;
  name: string;
  plate: string | null;
  capacity: number;
  isActive: boolean;
  notes: string | null;
}

export const listVans = () => apiFetch<{ vans: Van[] }>('/transport/vans');
export const createVan = (body: { name: string; plate?: string | null; capacity: number; notes?: string | null }) =>
  apiFetch<{ van: Van }>('/transport/vans', { method: 'POST', body });
export const updateVan = (id: string, body: Partial<Omit<Van, 'id'>>) =>
  apiFetch<{ van: Van }>(`/transport/vans/${id}`, { method: 'PATCH', body });

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
  status: RideStatus;
  van: string | null;
  hasShift: boolean;
}

export const getVanArrivals = (clientId?: string) =>
  apiFetch<{ arrivals: VanArrival[] }>(`/transport/arrivals${clientId ? `?clientId=${clientId}` : ''}`);
