import type {
  ClientGeofenceInput,
  ClientListResponse,
  ClientStateInput,
  ClientSummary,
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
