import type { Role } from '@alto-people/shared';
import { apiFetch } from './api';

/** Succession by store and the 9-box (apps/api/src/routes/successionBench.ts). */

export type BenchReadiness = 'READY_NOW' | 'READY_6_MONTHS' | 'READY_12_MONTHS';

export const BENCH_READINESS_LABELS: Record<BenchReadiness, string> = {
  READY_NOW: 'Ready now',
  READY_6_MONTHS: 'In 6 months',
  READY_12_MONTHS: 'In 12 months',
};

export interface StoreBench {
  id: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  leads: Array<{ userId: string; associateId: string | null; name: string; role: Role; photoUrl: string | null }>;
  bench: Array<{ id: string; associateId: string; name: string; title: string | null; photoUrl: string | null; readiness: BenchReadiness; notes: string | null }>;
  strength: 'covered' | 'thin' | 'empty';
}

export interface StoreBenchResponse {
  stores: StoreBench[];
  summary: { stores: number; covered: number; thin: number; empty: number; withoutLead: number };
}

export const listStoreBench = (clientId?: string) =>
  apiFetch<StoreBenchResponse>(`/succession/stores${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`);
export const addToBench = (locationId: string, body: { associateId: string; readiness: BenchReadiness; notes?: string | null }) =>
  apiFetch<{ id: string }>(`/succession/stores/${locationId}/bench`, { method: 'POST', body });
export const updateBench = (id: string, body: { readiness?: BenchReadiness; notes?: string | null }) =>
  apiFetch<{ ok: true }>(`/succession/bench/${id}`, { method: 'PATCH', body });
export const removeFromBench = (id: string) => apiFetch<void>(`/succession/bench/${id}`, { method: 'DELETE' });

export interface NineBoxPerson {
  associateId: string;
  name: string;
  title: string | null;
  photoUrl: string | null;
  reviewRating: number | null;
  /** 1 low – 3 high, from the latest shared review. */
  performance: 1 | 2 | 3 | null;
  /** 1 low – 3 high, rated by HR. */
  potential: 1 | 2 | 3 | null;
  potentialNotes: string | null;
}

export const getNineBox = (clientId?: string) =>
  apiFetch<{ people: NineBoxPerson[]; truncated: boolean; limit: number }>(`/succession/nine-box${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`);
export const ratePotential = (associateId: string, body: { potential: number; notes?: string | null }) =>
  apiFetch<{ ok: true }>(`/succession/potential/${associateId}`, { method: 'PUT', body });
