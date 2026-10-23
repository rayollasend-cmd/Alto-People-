import type { AuditCategory, AuditSearchResponse } from '@alto-people/shared';
import { apiFetch } from './api';

export interface AuditFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  clientId?: string;
  since?: string;
  before?: string;
  q?: string;
  /** A reviewer's category (shared auditLog.ts). */
  category?: AuditCategory;
  /** '1' leaves out the API's own request trail. */
  hideSystem?: '1';
  limit?: number;
}

function toQuery(f: AuditFilters): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function searchAuditLogs(filters: AuditFilters = {}): Promise<AuditSearchResponse> {
  return apiFetch<AuditSearchResponse>(`/audit/logs${toQuery(filters)}`);
}

/**
 * URL for the CSV export — bound to the same proxy + cookie auth as
 * apiFetch. Hand to an `<a download>` so the browser streams it.
 */
export function auditCsvUrl(filters: AuditFilters = {}): string {
  const { limit: _limit, ...rest } = filters;
  return `/api/audit/logs.csv${toQuery(rest)}`;
}

/** The full archive (manage:org): every row, with the chain's hashes. */
export const AUDIT_ARCHIVE_URL = '/api/audit/export.csv';

export interface AuditActor {
  id: string;
  email: string;
  name: string;
}

/** The Actor filter's people-picker: this organization's accounts by name or email. */
export function searchAuditActors(q: string): Promise<{ actors: AuditActor[] }> {
  return apiFetch<{ actors: AuditActor[] }>(`/audit/actors?q=${encodeURIComponent(q)}`);
}

/** One account by id — the name for an actor kept in the URL. */
export function getAuditActor(id: string): Promise<{ actors: AuditActor[] }> {
  return apiFetch<{ actors: AuditActor[] }>(`/audit/actors?id=${encodeURIComponent(id)}`);
}
