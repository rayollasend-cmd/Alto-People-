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

/** How ready a declaration would be right now (apps/api/src/lib/emergency.ts emergencyReadiness). */
export interface EmergencyReadiness {
  /** People a declaration for every site would tell. */
  reach: number;
  /** Of them, with a phone number on file. */
  withPhone: number;
  /** The language each would be told in, most first. */
  languages: Array<{ lang: 'en' | 'es' | 'tr'; people: number }>;
  /** In-service vans with a driver and their seats; null when the tenant runs no vans. */
  vans: { ready: number; seats: number; inService: number } | null;
}

export function getEmergencyReadiness(): Promise<EmergencyReadiness> {
  return apiFetch<EmergencyReadiness>('/emergency/readiness');
}
