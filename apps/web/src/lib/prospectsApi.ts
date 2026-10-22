import type { ProspectInput, ProspectListResponse, ProspectOwner, ProspectRow, ProspectUpdate } from '@alto-people/shared';
import { apiFetch } from './api';

/** The new-business pipeline (Clients → Pipeline); see routes/clientProspects.ts. */

export const PROSPECTS_KEY = ['clientProspects', 'list'] as const;
export const PROSPECT_OWNERS_KEY = ['clientProspects', 'owners'] as const;

export function listProspects(): Promise<ProspectListResponse> {
  return apiFetch<ProspectListResponse>('/client-prospects');
}

export function listProspectOwners(): Promise<{ owners: ProspectOwner[] }> {
  return apiFetch<{ owners: ProspectOwner[] }>('/client-prospects/owners');
}

export function createProspect(body: ProspectInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>('/client-prospects', { method: 'POST', body });
}

export function updateProspect(id: string, body: ProspectUpdate): Promise<ProspectRow> {
  return apiFetch<ProspectRow>(`/client-prospects/${id}`, { method: 'PATCH', body });
}

export function deleteProspect(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/client-prospects/${id}`, { method: 'DELETE' });
}
