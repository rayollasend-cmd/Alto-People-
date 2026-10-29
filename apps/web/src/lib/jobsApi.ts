import type {
  Job,
  JobCreateInput,
  JobListResponse,
  JobUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from './api';
import type { Gated } from './approvalRequestsApi';

export function listJobs(opts: { clientId?: string; includeInactive?: boolean } = {}): Promise<JobListResponse> {
  const p = new URLSearchParams();
  if (opts.clientId) p.set('clientId', opts.clientId);
  if (opts.includeInactive) p.set('includeInactive', 'true');
  const qs = p.toString();
  return apiFetch<JobListResponse>(`/jobs${qs ? `?${qs}` : ''}`);
}

/** A rate on the new job goes to a second person (202 pending, with the job as created) when the switch says so. */
export function createJob(body: JobCreateInput): Promise<Gated<Job, { job: Job }>> {
  return apiFetch<Gated<Job, { job: Job }>>('/jobs', { method: 'POST', body });
}

/** A bill-rate change goes to a second person (202 pending, with the job's other edits applied). */
export function updateJob(id: string, body: JobUpdateInput): Promise<Gated<Job, { job: Job }>> {
  return apiFetch<Gated<Job, { job: Job }>>(`/jobs/${id}`, { method: 'PATCH', body });
}

export function deleteJob(id: string): Promise<void> {
  return apiFetch<void>(`/jobs/${id}`, { method: 'DELETE' });
}
