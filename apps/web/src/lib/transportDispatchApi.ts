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
  direction: RideDirection;
  serviceDate: string;
  store: { id: string; name: string; timezone: string };
  vanId: string | null;
  driverUserId: string | null;
  departAt: string;
  /** To work: when the van gets to the store. */
  arriveAt: string | null;
  rides: PlannedStop[];
  warnings: string[];
}

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
