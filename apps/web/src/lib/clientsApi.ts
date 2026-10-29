import type {
  ClientCreateInput,
  ClientListResponse,
  ClientPerformanceResponse,
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
    /** The account numbers (health, fill rate, hours, owner, money for statements readers) — the clients list only; pickers leave it off. */
    metrics?: boolean;
    /** The billed range (YYYY-MM-DD, inclusive); the API defaults to this month to date. */
    from?: string;
    to?: string;
  } = {}
): Promise<ClientListResponse> {
  const sp = new URLSearchParams();
  if (filters.status) sp.set('status', filters.status);
  if (filters.q && filters.q.trim()) sp.set('q', filters.q.trim());
  if (filters.cursor) sp.set('cursor', filters.cursor);
  if (filters.limit != null) sp.set('limit', String(filters.limit));
  if (filters.metrics) sp.set('include', 'metrics');
  if (filters.from && filters.to) {
    sp.set('from', filters.from);
    sp.set('to', filters.to);
  }
  const qs = sp.toString();
  return apiFetch<ClientListResponse>(`/clients${qs ? `?${qs}` : ''}`);
}

/** A client's Performance tab: 12 weeks, statements (money readers), NPS (executives). */
export function getClientPerformance(id: string): Promise<ClientPerformanceResponse> {
  return apiFetch<ClientPerformanceResponse>(`/clients/${id}/performance`);
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
  /** When the money arrived and how (default: today, "Other"). */
  paid: { receivedOn?: string; method?: 'ACH' | 'CHECK' | 'WIRE' | 'CARD' | 'OTHER' } = {},
): Promise<ClientStatement> {
  return apiFetch(`/clients/${clientId}/statements/${statementId}/mark-paid`, {
    method: 'POST',
    body: { ...(paymentRef ? { paymentRef } : {}), ...paid },
  });
}

/** One row of the statement week close (finance walk 6): the statement and what closing needs. */
export type StatementRollupRow = ClientStatement & {
  clientName: string;
  dueOn: string | null;
  daysLate: number;
  /** What is still open on it (net of partial payments); 0 when paid or a draft. */
  open: number;
  /** The client's statement before this one, for the change in hours and dollars. */
  previous: { statementId: string; periodStart: string; hours: number; amount: number } | null;
};

export interface StatementsRollup {
  statements: StatementRollupRow[];
  /** Weeks with approved, billable time that no statement covers. */
  missingWeeks: Array<{ clientId: string; clientName: string; weekStart: string; hours: number }>;
}

export function getStatementsRollup(): Promise<StatementsRollup> {
  return apiFetch('/clients/statements/rollup');
}

/** Invoicing: the PO one statement bills against and, once final, its due date. */
export function updateClientStatementTerms(
  clientId: string,
  statementId: string,
  body: { poNumber?: string | null; dueAt?: string | null },
): Promise<ClientStatement> {
  return apiFetch(`/clients/${clientId}/statements/${statementId}`, { method: 'PATCH', body });
}

export interface ClientDunning {
  poNumber: string | null;
  paymentTermsDays: number;
  /** Sales tax on this client's statements. */
  salesTaxable?: boolean;
  salesTaxRatePct?: number | null;
  paused: { at: string; note: string | null; byUserId: string | null } | null;
  reminders: Array<{ id: string; stage: number; sentAt: string; recipients: number; statementId: string; number: number | null; periodStart: string; periodEnd: string }>;
}

export function updateClientBillingTerms(
  clientId: string,
  body: { poNumber?: string | null; paymentTermsDays?: number; salesTaxable?: boolean; salesTaxRatePct?: number | null },
): Promise<{ poNumber: string | null; paymentTermsDays: number; salesTaxable: boolean; salesTaxRatePct: number | null }> {
  return apiFetch(`/clients/${clientId}/billing-terms`, { method: 'PATCH', body });
}

export function getClientDunning(clientId: string): Promise<ClientDunning> {
  return apiFetch(`/clients/${clientId}/dunning`);
}

export function pauseClientDunning(clientId: string, note: string): Promise<{ ok: true }> {
  return apiFetch(`/clients/${clientId}/dunning/pause`, { method: 'POST', body: { note } });
}

export function resumeClientDunning(clientId: string): Promise<{ ok: true }> {
  return apiFetch(`/clients/${clientId}/dunning/pause`, { method: 'DELETE' });
}

/** Weekly client-facing service report. week = any date in the desired
 *  org week (YYYY-MM-DD); omitted = last completed week. */
export function clientServiceReportUrl(clientId: string, week?: string): string {
  return `/api/clients/${clientId}/service-report.pdf${week ? `?week=${week}` : ''}`;
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

/* ---- Portal access (the store manager site) ------------------------- */

export interface PortalUserRow {
  id: string;
  email: string;
  status: 'ACTIVE' | 'INVITED' | 'DISABLED';
  createdAt: string;
  locationId: string | null;
  locationName: string | null;
  inviteExpiresAt: string | null;
  /** Engagement off the audit log: are they using it. */
  lastSeenAt: string | null;
  signIns7d: number;
  downloads: Array<{ at: string; from: string; to: string }>;
}

export interface PortalReadiness {
  accounts: number;
  stores: Array<{ id: string; name: string; hasTarget: boolean; portalAccounts: number }>;
  leadPositions: number;
  supervisors: Array<{ name: string; hasPhone: boolean }>;
  photos: { withPhoto: number; total: number; pct: number | null };
  supportEmail: string | null;
  mfa: { policy: string; coversPortal: boolean };
  gaps: string[];
}

export function listPortalUsers(clientId: string): Promise<{ users: PortalUserRow[] }> {
  return apiFetch(`/clients/${clientId}/portal-users`);
}

export function invitePortalUser(
  clientId: string,
  /** Brief 1A-4: store-level by default; the whole client must be asked for by name. */
  body: { email: string; locationId: string | null; name?: string; wholeClient?: boolean },
): Promise<PortalUserRow & { emailFailed: string | null }> {
  return apiFetch(`/clients/${clientId}/portal-users`, { method: 'POST', body });
}

export function disablePortalUser(clientId: string, userId: string): Promise<void> {
  return apiFetch<void>(`/clients/${clientId}/portal-users/${userId}/disable`, { method: 'POST' });
}

export function getPortalReadiness(clientId: string): Promise<PortalReadiness> {
  return apiFetch(`/clients/${clientId}/portal-readiness`);
}
