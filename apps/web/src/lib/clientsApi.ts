import type {
  ClientCreateInput,
  ClientListResponse,
  ClientStatement,
  ClientStatementListResponse,
  ClientStateInput,
  ClientStatus,
  ClientSummary,
  ClientUpdateInput,
  LocationCreateInput,
  LocationListResponse,
  LocationSummary,
  LocationUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listClients(
  filters: {
    status?: ClientStatus;
    q?: string;
    /** Id of the last client of the previous page (ClientListResponse.nextCursor). */
    cursor?: string;
    limit?: number;
  } = {}
): Promise<ClientListResponse> {
  const sp = new URLSearchParams();
  if (filters.status) sp.set('status', filters.status);
  if (filters.q && filters.q.trim()) sp.set('q', filters.q.trim());
  if (filters.cursor) sp.set('cursor', filters.cursor);
  if (filters.limit != null) sp.set('limit', String(filters.limit));
  const qs = sp.toString();
  return apiFetch<ClientListResponse>(`/clients${qs ? `?${qs}` : ''}`);
}

export function getClient(id: string): Promise<ClientSummary> {
  return apiFetch<ClientSummary>(`/clients/${id}`);
}

export function setClientState(id: string, body: ClientStateInput): Promise<ClientSummary> {
  return apiFetch<ClientSummary>(`/clients/${id}/state`, {
    method: 'PUT',
    body,
  });
}

export function createClient(body: ClientCreateInput): Promise<ClientSummary> {
  return apiFetch<ClientSummary>('/clients', { method: 'POST', body });
}

export function updateClient(
  id: string,
  body: ClientUpdateInput
): Promise<ClientSummary> {
  return apiFetch<ClientSummary>(`/clients/${id}`, { method: 'PATCH', body });
}

export function archiveClient(id: string): Promise<void> {
  return apiFetch<void>(`/clients/${id}`, { method: 'DELETE' });
}

/* ----- Statements (billing/SLA) ------------------------------------------ */

export function listClientStatements(
  clientId: string,
): Promise<ClientStatementListResponse> {
  return apiFetch(`/clients/${clientId}/statements`);
}

/** One-click weekly run: draft (or refresh) EVERY active client's
 *  statement for the last completed org week. FINAL periods are skipped. */
export function generateDueStatements(): Promise<{
  periodStart: string;
  periodEnd: string;
  generated: number;
  refreshed: number;
  skippedFinal: number;
}> {
  return apiFetch('/clients/statements/generate-due', { method: 'POST' });
}

export function upsertClientStatement(
  clientId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ClientStatement> {
  return apiFetch(`/clients/${clientId}/statements`, {
    method: 'POST',
    body: { periodStart, periodEnd },
  });
}

export function finalizeClientStatement(
  clientId: string,
  statementId: string,
): Promise<ClientStatement> {
  return apiFetch(`/clients/${clientId}/statements/${statementId}/finalize`, {
    method: 'POST',
    body: {},
  });
}

export function markClientStatementPaid(
  clientId: string,
  statementId: string,
  paymentRef?: string,
): Promise<ClientStatement> {
  return apiFetch(`/clients/${clientId}/statements/${statementId}/mark-paid`, {
    method: 'POST',
    body: paymentRef ? { paymentRef } : {},
  });
}

export function clientStatementPdfUrl(clientId: string, statementId: string): string {
  return `/api/clients/${clientId}/statements/${statementId}.pdf`;
}

export function clientStatementCsvUrl(clientId: string, statementId: string): string {
  return `/api/clients/${clientId}/statements/${statementId}.csv`;
}

export function listClientLocations(
  id: string,
  opts: { includeInactive?: boolean } = {},
): Promise<LocationListResponse> {
  const qs = opts.includeInactive ? '?includeInactive=true' : '';
  return apiFetch<LocationListResponse>(`/clients/${id}/locations${qs}`);
}

export function createLocation(
  clientId: string,
  body: LocationCreateInput,
): Promise<LocationSummary> {
  return apiFetch<LocationSummary>(`/clients/${clientId}/locations`, {
    method: 'POST',
    body,
  });
}

export function updateLocation(
  clientId: string,
  locationId: string,
  body: LocationUpdateInput,
): Promise<LocationSummary> {
  return apiFetch<LocationSummary>(`/clients/${clientId}/locations/${locationId}`, {
    method: 'PATCH',
    body,
  });
}

export function archiveLocation(clientId: string, locationId: string): Promise<void> {
  return apiFetch<void>(`/clients/${clientId}/locations/${locationId}`, {
    method: 'DELETE',
  });
}
