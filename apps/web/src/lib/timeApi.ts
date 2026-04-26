import type {
  ActiveTimeEntryResponse,
  ClockInInput,
  ClockOutInput,
  TimeApproveInput,
  TimeEntry,
  TimeEntryListResponse,
  TimeEntryStatus,
  TimeRejectInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function getActiveTimeEntry(): Promise<ActiveTimeEntryResponse> {
  return apiFetch<ActiveTimeEntryResponse>('/time/me/active');
}

export function listMyTimeEntries(): Promise<TimeEntryListResponse> {
  return apiFetch<TimeEntryListResponse>('/time/me/entries');
}

export function clockIn(body: ClockInInput = {}): Promise<TimeEntry> {
  return apiFetch<TimeEntry>('/time/me/clock-in', { method: 'POST', body });
}

export function clockOut(body: ClockOutInput = {}): Promise<TimeEntry> {
  return apiFetch<TimeEntry>('/time/me/clock-out', { method: 'POST', body });
}

export function listAdminTimeEntries(filters: {
  status?: TimeEntryStatus;
  associateId?: string;
  clientId?: string;
} = {}): Promise<TimeEntryListResponse> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.associateId) params.set('associateId', filters.associateId);
  if (filters.clientId) params.set('clientId', filters.clientId);
  const qs = params.toString();
  return apiFetch<TimeEntryListResponse>(
    `/time/admin/entries${qs ? `?${qs}` : ''}`
  );
}

export function approveTimeEntry(
  id: string,
  body: TimeApproveInput = {}
): Promise<TimeEntry> {
  return apiFetch<TimeEntry>(`/time/admin/entries/${id}/approve`, {
    method: 'POST',
    body,
  });
}

export function rejectTimeEntry(
  id: string,
  body: TimeRejectInput
): Promise<TimeEntry> {
  return apiFetch<TimeEntry>(`/time/admin/entries/${id}/reject`, {
    method: 'POST',
    body,
  });
}
