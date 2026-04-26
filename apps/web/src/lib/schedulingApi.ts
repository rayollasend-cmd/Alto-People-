import type {
  Shift,
  ShiftAssignInput,
  ShiftCancelInput,
  ShiftCreateInput,
  ShiftListResponse,
  ShiftStatus,
  ShiftUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

interface ShiftListFilters {
  status?: ShiftStatus;
  clientId?: string;
  from?: string;
  to?: string;
}

function qs(filters: ShiftListFilters): string {
  const p = new URLSearchParams();
  if (filters.status) p.set('status', filters.status);
  if (filters.clientId) p.set('clientId', filters.clientId);
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function listShifts(filters: ShiftListFilters = {}): Promise<ShiftListResponse> {
  return apiFetch<ShiftListResponse>(`/scheduling/shifts${qs(filters)}`);
}

export function listMyShifts(): Promise<ShiftListResponse> {
  return apiFetch<ShiftListResponse>('/scheduling/me/shifts');
}

export function createShift(body: ShiftCreateInput): Promise<Shift> {
  return apiFetch<Shift>('/scheduling/shifts', { method: 'POST', body });
}

export function updateShift(id: string, body: ShiftUpdateInput): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/shifts/${id}`, { method: 'PATCH', body });
}

export function assignShift(id: string, body: ShiftAssignInput): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/shifts/${id}/assign`, { method: 'POST', body });
}

export function unassignShift(id: string): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/shifts/${id}/unassign`, { method: 'POST' });
}

export function cancelShift(id: string, body: ShiftCancelInput): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/shifts/${id}/cancel`, { method: 'POST', body });
}
