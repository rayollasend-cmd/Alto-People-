import type {
  Job,
  JobCreateInput,
  JobListResponse,
  JobUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listJobs(opts: { clientId?: string; includeInactive?: boolean } = {}): Promise<JobListResponse> {
  const p = new URLSearchParams();
  if (opts.clientId) p.set('clientId', opts.clientId);
  if (opts.includeInactive) p.set('includeInactive', 'true');
  const qs = p.toString();
  return apiFetch<JobListResponse>(`/jobs${qs ? `?${qs}` : ''}`);
}

export function createJob(body: JobCreateInput): Promise<Job> {
  return apiFetch<Job>('/jobs', { method: 'POST', body });
}

export function updateJob(id: string, body: JobUpdateInput): Promise<Job> {
  return apiFetch<Job>(`/jobs/${id}`, { method: 'PATCH', body });
}

export function deleteJob(id: string): Promise<void> {
  return apiFetch<void>(`/jobs/${id}`, { method: 'DELETE' });
}
