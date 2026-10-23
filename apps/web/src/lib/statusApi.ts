import type { PublicStatus, StatusIncidentCreate, StatusIncidentUpdateInput } from '@alto-people/shared';
import { apiFetch } from './api';

/** The public status page beside the Trust Center, and the operator's incident posts. */
export const getPublicStatus = () => apiFetch<PublicStatus>('/status/public');

export interface StatusIncidentAdmin {
  id: string;
  title: string;
  component: PublicStatus['incidents'][number]['component'];
  impact: PublicStatus['incidents'][number]['impact'];
  state: PublicStatus['incidents'][number]['state'];
  startedAt: string;
  resolvedAt: string | null;
  createdByUserId: string | null;
  updates: Array<{ id: string; at: string; state: PublicStatus['incidents'][number]['state']; note: string; byUserId: string | null }>;
}

export const listStatusIncidents = () => apiFetch<{ incidents: StatusIncidentAdmin[] }>('/status/incidents');
export const postStatusIncident = (body: StatusIncidentCreate) => apiFetch<StatusIncidentAdmin>('/status/incidents', { method: 'POST', body });
export const updateStatusIncident = (id: string, body: StatusIncidentUpdateInput) =>
  apiFetch<StatusIncidentAdmin>(`/status/incidents/${id}/updates`, { method: 'POST', body });

/** Incident updates by email (double opt-in): ask, confirm from the emailed link, stop from any update. */
export const subscribeToStatus = (email: string) => apiFetch<{ ok: true }>('/status/subscribe', { method: 'POST', body: { email } });
export const confirmStatusSubscription = (token: string) => apiFetch<{ ok: true }>('/status/subscribe/confirm', { method: 'POST', body: { token } });
export const unsubscribeFromStatus = (token: string) => apiFetch<{ ok: true }>('/status/unsubscribe', { method: 'POST', body: { token } });
