import type {
  ClientCreateInput,
  ClientGeofenceInput,
  ClientListResponse,
  ClientStateInput,
  ClientSummary,
  ClientUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export interface ClientGeofence {
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusMeters: number | null;
}

export function listClients(): Promise<ClientListResponse> {
  return apiFetch<ClientListResponse>('/clients');
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
