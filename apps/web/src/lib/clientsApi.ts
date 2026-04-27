import type {
  ClientCreateInput,
  ClientGeofenceInput,
  ClientListResponse,
  ClientStateInput,
  ClientStatus,
  ClientSummary,
  ClientUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export interface ClientGeofence {
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusMeters: number | null;
}

export function listClients(
  filters: { status?: ClientStatus; q?: string } = {}
): Promise<ClientListResponse> {
  const sp = new URLSearchParams();
  if (filters.status) sp.set('status', filters.status);
  if (filters.q && filters.q.trim()) sp.set('q', filters.q.trim());
  const qs = sp.toString();
  return apiFetch<ClientListResponse>(`/clients${qs ? `?${qs}` : ''}`);
}

export function getClient(id: string): Promise<ClientSummary> {
  return apiFetch<ClientSummary>(`/clients/${id}`);
}

export function getClientGeofence(id: string): Promise<ClientGeofence> {
  return apiFetch<ClientGeofence>(`/clients/${id}/geofence`);
}

export function setClientState(id: string, body: ClientStateInput): Promise<ClientSummary> {
  return apiFetch<ClientSummary>(`/clients/${id}/state`, {
    method: 'PUT',
    body,
  });
}

export function setClientGeofence(
  id: string,
  body: ClientGeofenceInput
): Promise<ClientGeofence> {
  return apiFetch<ClientGeofence>(`/clients/${id}/geofence`, {
    method: 'PUT',
    body,
  });
}

export function createClient(body: ClientCreateInput): Promise<ClientSummary> {
  return apiFetch<ClientSummary>('/clients', { method: 'POST', body });
}

export function updateClient(
  id: string,
  body: ClientUpdateInput
): Promise<ClientSummary> {
  return apiFetch<ClientSummary>(`/clients/${id}`, { method: 'PATCH', body });
}

export function archiveClient(id: string): Promise<void> {
  return apiFetch<void>(`/clients/${id}`, { method: 'DELETE' });
}
