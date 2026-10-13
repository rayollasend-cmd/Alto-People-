import type {
  EmergencyBoard,
  EmergencyCheckInInput,
  EmergencyDeclareInput,
  EmergencyListResponse,
  EmergencySitesResponse,
  EmergencySummary,
  MyEmergencyResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

/** The associate's side: the active emergency they are in, and their one tap. */
export function getMyEmergency(): Promise<MyEmergencyResponse> {
  return apiFetch<MyEmergencyResponse>('/emergency/me');
}

export function emergencyCheckIn(id: string, body: EmergencyCheckInInput): Promise<MyEmergencyResponse> {
  return apiFetch<MyEmergencyResponse>(`/emergency/${id}/check-in`, { method: 'POST', body });
}

/** The switch and the board. */
export function listEmergencies(): Promise<EmergencyListResponse> {
  return apiFetch<EmergencyListResponse>('/emergency');
}

export function listEmergencySites(): Promise<EmergencySitesResponse> {
  return apiFetch<EmergencySitesResponse>('/emergency/sites');
}

export function getEmergencyBoard(id: string): Promise<EmergencyBoard> {
  return apiFetch<EmergencyBoard>(`/emergency/${id}/board`);
}

export function declareEmergency(body: EmergencyDeclareInput): Promise<EmergencySummary> {
  return apiFetch<EmergencySummary>('/emergency', { method: 'POST', body });
}

export function standDownEmergency(id: string): Promise<EmergencySummary> {
  return apiFetch<EmergencySummary>(`/emergency/${id}/stand-down`, { method: 'POST' });
}
