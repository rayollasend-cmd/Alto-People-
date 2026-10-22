import { apiFetch } from './api';
import type { GeoPoint, RideDirection } from './transportApi';

/**
 * The command center's dispatch helpers: plan a whole day's waiting
 * bookings onto runs in one go, put one run's pickups in the best order
 * with times worked back from the arrive-by, and message a van's riders.
 */

export interface PlannedStop {
  rideId: string;
  name: string;
  place: string;
  pickupAt: string;
  point: GeoPoint | null;
}

export interface RunProposal {
  key: string;
  /** new: a run to create. topUp: riders added to a run that already exists (transport walk 3). */
  kind?: 'new' | 'topUp';
  runId?: string | null;
  direction: RideDirection;
  serviceDate: string;
  store: { id: string; name: string; timezone: string; point?: GeoPoint | null };
  vanId: string | null;
  driverUserId: string | null;
  departAt: string;
  /** To work: when the van gets to the store. */
  arriveAt: string | null;
  /** A top-up lists the run's riders too (`existing`), re-timed with the new ones. */
  rides: Array<PlannedStop & { existing?: boolean }>;
  seats?: { taken: number; capacity: number | null; added: number };
  warnings: string[];
}

/** Transport walk 10: the whole plan in one request — all or nothing. */
export interface BatchDispatchInput {
  runs: Array<{ key: string; vanId: string; driverUserId: string; direction: RideDirection; serviceDate: string; departAt: string; notes?: string; rides: Array<{ rideId: string; pickupAt: string }> }>;
  topUps: Array<{ key: string; runId: string; rides: Array<{ rideId: string; pickupAt: string }> }>;
}
export interface BatchDispatchResult {
  created: Array<{ key: string; runId: string }>;
  updated: Array<{ key: string; runId: string }>;
}
/** 409 batch_refused carries these — one line per proposal that can't go; nothing was written. */
export interface BatchRefusal {
  key: string;
  code: string;
  message: string;
}
export const dispatchBatch = (body: BatchDispatchInput) => apiFetch<BatchDispatchResult>('/transport/runs/batch', { method: 'POST', body });

export interface DayPlan {
  date: string;
  proposals: RunProposal[];
  unplaced: Array<{ rideId: string; name: string; reason: string }>;
}

/** Proposed runs for every booking still waiting on a van that day — nothing is saved. */
export const planDay = (date: string) => apiFetch<DayPlan>('/transport/plan', { method: 'POST', body: { date } });

/** The best pickup order for these rides, each with a pickup time. */
export const routeRides = (rideIds: string[]) =>
  apiFetch<{ direction: RideDirection; departAt: string; arriveAt: string | null; rides: Array<{ rideId: string; pickupAt: string }> }>(
    '/transport/route',
    { method: 'POST', body: { rideIds } },
  );

/** Tell everyone on a run (and its driver) something — "running 10 late". */
export const messageRun = (runId: string, body: string) =>
  apiFetch<{ sent: number }>(`/transport/runs/${runId}/message`, { method: 'POST', body: { body } });
