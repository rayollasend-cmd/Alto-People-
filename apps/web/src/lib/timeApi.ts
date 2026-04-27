import type {
  ActiveDashboardResponse,
  ActiveTimeEntryResponse,
  BreakEntry,
  BreakType,
  BulkTimeApproveInput,
  BulkTimeRejectInput,
  BulkTimeResponse,
  ClockInInputV2,
  ClockOutInputV2,
  TimeApproveInput,
  TimeEntry,
  TimeEntryListResponse,
  TimeEntryStatus,
  TimeExportInput,
  TimeRejectInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function getActiveTimeEntry(): Promise<ActiveTimeEntryResponse> {
  return apiFetch<ActiveTimeEntryResponse>('/time/me/active');
}

export function listMyTimeEntries(filters: {
  from?: string;
  to?: string;
} = {}): Promise<TimeEntryListResponse> {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const qs = params.toString();
  return apiFetch<TimeEntryListResponse>(
    `/time/me/entries${qs ? `?${qs}` : ''}`
  );
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
  from?: string;
  to?: string;
  search?: string;
} = {}): Promise<TimeEntryListResponse> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.associateId) params.set('associateId', filters.associateId);
  if (filters.clientId) params.set('clientId', filters.clientId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.search) params.set('search', filters.search);
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

export function bulkApproveTimeEntries(
  body: BulkTimeApproveInput
): Promise<BulkTimeResponse> {
  return apiFetch<BulkTimeResponse>('/time/admin/bulk-approve', {
    method: 'POST',
    body,
  });
}

export function bulkRejectTimeEntries(
  body: BulkTimeRejectInput
): Promise<BulkTimeResponse> {
  return apiFetch<BulkTimeResponse>('/time/admin/bulk-reject', {
    method: 'POST',
    body,
  });
}

/**
 * Phase 65 — POSTs to a streaming export route, gets back a Blob, and
 * triggers a browser download via a synthetic <a download>. We can't use
 * apiFetch here (it parses JSON), so we hand-roll the request the same way
 * scheduling export does.
 */
export async function exportTimeEntries(
  format: 'csv' | 'pdf',
  body: TimeExportInput
): Promise<void> {
  const res = await fetch(`/api/time/admin/export.${format}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Try to surface the server's error message; fall back to a generic one.
    let message = `${format.toUpperCase()} export failed.`;
    try {
      const data = await res.json();
      if (data?.error?.message) message = data.error.message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  // Prefer the server's Content-Disposition filename if it set one.
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = m?.[1] ?? `time-export.${format}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
