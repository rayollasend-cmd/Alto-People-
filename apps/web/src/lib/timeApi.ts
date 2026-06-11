import type {
  ActiveDashboardResponse,
  ActiveTimeEntryResponse,
  AdminCreateTimeEntryInput,
  AdminEditTimeEntryInput,
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

/** Cheap server-side COUNT for KPI badges — the list endpoint caps at 500
 *  rows, so counting its length both over-fetched and under-counted. */
export function countAdminTimeEntries(
  status?: TimeEntryStatus,
): Promise<{ count: number }> {
  const qs = status ? `?status=${status}` : '';
  return apiFetch<{ count: number }>(`/time/admin/entries/count${qs}`);
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

/** Admin: create a time entry on behalf of an associate. Omit clockOutAt to
 *  clock them in (ACTIVE); supply it to log a completed shift. */
export function adminCreateTimeEntry(
  body: AdminCreateTimeEntryInput
): Promise<TimeEntry> {
  return apiFetch<TimeEntry>('/time/admin/entries', { method: 'POST', body });
}

/** Admin: edit a pre-approval entry (times/job/notes), or clock an associate
 *  out by passing clockOutAt on their ACTIVE entry. */
export function adminEditTimeEntry(
  id: string,
  body: AdminEditTimeEntryInput
): Promise<TimeEntry> {
  return apiFetch<TimeEntry>(`/time/admin/entries/${id}`, {
    method: 'PATCH',
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
async function downloadExportPost(
  url: string,
  body: unknown,
  fallbackName: string
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Surface the server's error message; fall back to a generic one.
    let message = 'Export failed.';
    try {
      const data = await res.json();
      if (data?.error?.message) message = data.error.message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  // Prefer the server's Content-Disposition filename if it set one.
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = m?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

export function exportTimeEntries(
  format: 'csv' | 'pdf',
  body: TimeExportInput
): Promise<void> {
  return downloadExportPost(
    `/api/time/admin/export.${format}`,
    body,
    `time-export.${format}`
  );
}

/** Per-associate summary CSV: regular vs overtime hours + pay rate, scoped
 *  to a facility (Location), APPROVED time only. */
export function exportTimeSummary(body: TimeExportInput): Promise<void> {
  return downloadExportPost(
    '/api/time/admin/export-summary.csv',
    body,
    'time-summary.csv'
  );
}
