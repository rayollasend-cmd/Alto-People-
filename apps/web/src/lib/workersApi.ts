import type {
  WorkerAssignmentInput,
  WorkerInput,
  WorkerStatus,
  WorkerSummary,
  WorkerType,
  WorkerUpdate,
  WorkersResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Workers (Brief 1D-1) — people, AI agents and robots as one registry.
 * Every worker has an owner, a status and a capability list; a PERSON
 * worker mirrors an associate and is created by the server's sweep.
 */

export type { WorkerAssignmentInput, WorkerInput, WorkerStatus, WorkerSummary, WorkerType, WorkerUpdate, WorkersResponse };

export interface WorkerFilters {
  type?: WorkerType;
  status?: WorkerStatus;
}

export function listWorkers(filters: WorkerFilters = {}): Promise<WorkersResponse> {
  const qs = new URLSearchParams();
  if (filters.type) qs.set('type', filters.type);
  if (filters.status) qs.set('status', filters.status);
  const q = qs.toString();
  return apiFetch<WorkersResponse>(`/workers${q ? `?${q}` : ''}`);
}

export function getWorker(id: string): Promise<WorkerSummary> {
  return apiFetch<WorkerSummary>(`/workers/${encodeURIComponent(id)}`);
}

export function createWorker(body: WorkerInput): Promise<WorkerSummary> {
  return apiFetch<WorkerSummary>('/workers', { method: 'POST', body });
}

export function updateWorker(id: string, body: WorkerUpdate): Promise<WorkerSummary> {
  return apiFetch<WorkerSummary>(`/workers/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

export function assignWorkerSite(id: string, body: WorkerAssignmentInput): Promise<WorkerSummary> {
  return apiFetch<WorkerSummary>(`/workers/${encodeURIComponent(id)}/assignments`, { method: 'POST', body });
}

/** The sweep: a PERSON worker for every associate that lacks one. */
export function ensurePersonWorkers(): Promise<{ made: number }> {
  return apiFetch<{ made: number }>('/workers/ensure-people', { method: 'POST' });
}
