import type {
  ActiveDashboardResponse,
  ActiveTimeEntryResponse,
  BreakEntry,
  BreakType,
  ClockInInputV2,
  ClockOutInputV2,
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

export function clockIn(body: ClockInInputV2 = {}): Promise<TimeEntry> {
  return apiFetch<TimeEntry>('/time/me/clock-in', { method: 'POST', body });
}

export function clockOut(body: ClockOutInputV2 = {}): Promise<TimeEntry> {
  return apiFetch<TimeEntry>('/time/me/clock-out', { method: 'POST', body });
}

export function startBreak(type: BreakType): Promise<BreakEntry> {
  return apiFetch<BreakEntry>('/time/me/break/start', {
    method: 'POST',
    body: { type },
  });
}

export function endBreak(): Promise<BreakEntry> {
  return apiFetch<BreakEntry>('/time/me/break/end', { method: 'POST' });
}

export function getActiveDashboard(): Promise<ActiveDashboardResponse> {
  return apiFetch<ActiveDashboardResponse>('/time/admin/active');
}

/**
 * Promise wrapper around the browser Geolocation API. Resolves to null if
 * the browser doesn't have geolocation, the user denied permission, or the
 * lookup times out — the caller decides whether to proceed without it.
 */
export function tryGetGeolocation(timeoutMs = 5_000): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 }
    );
  });
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
