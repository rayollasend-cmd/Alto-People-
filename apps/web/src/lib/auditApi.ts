import type { AuditSearchResponse } from '@alto-people/shared';
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
  return `/api/audit/logs.csv${toQuery(filters)}`;
}
