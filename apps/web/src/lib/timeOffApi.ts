import type {
  TimeOffCategory,
  TimeOffEntitlement,
  TimeOffEntitlementListResponse,
  TimeOffEntitlementUpsertInput,
  TimeOffMyBalanceResponse,
  TimeOffRequestCreateInput,
  TimeOffRequestDenyInput,
  TimeOffRequestListResponse,
  TimeOffRequestResponse,
  TimeOffRequestStatus,
} from '@alto-people/shared';
import { apiFetch } from './api';
import { withOfflineQueue } from './offlineQueue';

/** One approved leave in the two-week "Who's off" strip. */
export interface WhosOffRow {
  id: string;
  associateId: string;
  name: string;
  category: TimeOffCategory;
  startDate: string;
  endDate: string;
}

/** Who is out, in the caller's reach (GET /time-off/admin/summary). Counts are people. */
export interface TimeOffSummary {
  today: string;
  weekStart: string;
  weekEnd: string;
  horizonEnd: string;
  outToday: number;
  outThisWeek: number;
  pending: number;
  upcoming: number;
  whosOff: WhosOffRow[];
}

export function getTimeOffSummary() {
  return apiFetch<TimeOffSummary>('/time-off/admin/summary');
}

export function getMyBalance() {
  return apiFetch<TimeOffMyBalanceResponse>('/time-off/me/balance');
}

export function listMyRequests() {
  return apiFetch<TimeOffRequestListResponse>('/time-off/me/requests');
}

export function createMyRequest(input: TimeOffRequestCreateInput) {
  return apiFetch<TimeOffRequestResponse>('/time-off/me/requests', {
    method: 'POST',
    body: input,
  });
}

export function cancelMyRequest(id: string) {
  return apiFetch<TimeOffRequestResponse>(`/time-off/me/requests/${id}/cancel`, {
    method: 'POST',
    body: {},
  });
}

export function listAdminRequests(status?: TimeOffRequestStatus, opts: { associateId?: string } = {}) {
  const p = new URLSearchParams();
  if (status) p.set('status', status);
  if (opts.associateId) p.set('associateId', opts.associateId);
  const qs = p.toString();
  return apiFetch<TimeOffRequestListResponse>(`/time-off/admin/requests${qs ? `?${qs}` : ''}`);
}

/**
 * Access pack: a decision made with no signal is queued and sent when the
 * API answers again (lib/offlineQueue); the server's 409 on a request
 * someone else decided meanwhile drops it with a message.
 */
export function approveAdminRequest(id: string, note?: string, overrideReason?: string) {
  return withOfflineQueue(
    () =>
      apiFetch<TimeOffRequestResponse>(`/time-off/admin/requests/${id}/approve`, {
        method: 'POST',
        body: { note, overrideReason },
      }),
    { kind: 'time-off', label: 'approve a time-off request', method: 'POST', path: `/time-off/admin/requests/${id}/approve`, body: { note, overrideReason } },
  );
}

export interface BulkEntitlementResult {
  created: number;
  updated: number;
  skippedExisting: number;
  outOfScope: number;
}

/** One policy, applied to a whole roster instead of one person at a time. */
export function bulkUpsertEntitlements(body: {
  category: string;
  annualMinutes: number;
  carryoverMaxMinutes: number;
  policyAnchorMonth?: number;
  policyAnchorDay?: number;
  associateIds: string[];
  skipExisting?: boolean;
}) {
  return apiFetch<BulkEntitlementResult>('/time-off/admin/entitlements/bulk', {
    method: 'POST',
    body,
  });
}

export function denyAdminRequest(id: string, input: TimeOffRequestDenyInput) {
  return withOfflineQueue(
    () =>
      apiFetch<TimeOffRequestResponse>(`/time-off/admin/requests/${id}/deny`, {
        method: 'POST',
        body: input,
      }),
    { kind: 'time-off', label: 'deny a time-off request', method: 'POST', path: `/time-off/admin/requests/${id}/deny`, body: input },
  );
}

export interface BulkDecideResponse {
  decided: number;
  failed: Array<{ id: string; ok: false; error: string }>;
}

/** Decide many requests at once. `note` is required when denying. */
export function bulkDecideRequests(input: {
  ids: string[];
  decision: 'APPROVE' | 'DENY';
  note?: string;
}) {
  return apiFetch<BulkDecideResponse>('/time-off/admin/requests/bulk-decide', {
    method: 'POST',
    body: input,
  });
}

export function listAdminEntitlements(associateId?: string) {
  const qs = associateId ? `?associateId=${encodeURIComponent(associateId)}` : '';
  return apiFetch<TimeOffEntitlementListResponse>(
    `/time-off/admin/entitlements${qs}`
  );
}

export function upsertAdminEntitlement(input: TimeOffEntitlementUpsertInput) {
  return apiFetch<TimeOffEntitlement>('/time-off/admin/entitlements', {
    method: 'PUT',
    body: input,
  });
}

/* ----- Policies (how leave is earned, for whom) --------------------------- */

export type TimeOffAccrualMode = 'PER_HOUR_WORKED' | 'PER_PERIOD' | 'ANNUAL_GRANT';
export type TimeOffPolicyScope = 'ALL' | 'CLIENT' | 'SITE' | 'DEPARTMENT' | 'JOB_PROFILE';

export interface TimeOffTenureTier {
  afterMonths: number;
  accrualPerHour?: number | null;
  minutesPerPeriod?: number | null;
  annualMinutes?: number | null;
}

export interface TimeOffPolicyRow {
  id: string;
  name: string;
  category: TimeOffCategory;
  accrualMode: TimeOffAccrualMode;
  accrualPerHour: number | null;
  minutesPerPeriod: number | null;
  annualMinutes: number | null;
  policyAnchorDate: string;
  capMinutes: number | null;
  carryoverMaxMinutes: number;
  waitingPeriodDays: number;
  tenureTiers: TimeOffTenureTier[];
  isActive: boolean;
  notes: string | null;
  updatedAt: string;
  assignments: Array<{ id: string; scopeKind: TimeOffPolicyScope; scopeId: string | null }>;
  people: number;
}

export interface TimeOffPolicyInput {
  name: string;
  category: TimeOffCategory;
  accrualMode: TimeOffAccrualMode;
  accrualPerHour?: number | null;
  minutesPerPeriod?: number | null;
  annualMinutes?: number | null;
  policyAnchorDate?: string;
  capMinutes?: number | null;
  carryoverMaxMinutes?: number;
  waitingPeriodDays?: number;
  tenureTiers?: TimeOffTenureTier[];
  isActive?: boolean;
  notes?: string | null;
}

export function listTimeOffPolicies() {
  return apiFetch<{ policies: TimeOffPolicyRow[]; scopeNames: Record<string, string> }>('/time-off/policies');
}

export function listTimeOffPolicyScopes() {
  return apiFetch<Record<Exclude<TimeOffPolicyScope, 'ALL'>, Array<{ id: string; name: string }>>>('/time-off/policies/scopes');
}

export function createTimeOffPolicy(input: TimeOffPolicyInput) {
  return apiFetch<TimeOffPolicyRow>('/time-off/policies', { method: 'POST', body: input });
}

export function updateTimeOffPolicy(id: string, input: Partial<TimeOffPolicyInput>) {
  return apiFetch<TimeOffPolicyRow>(`/time-off/policies/${id}`, { method: 'PATCH', body: input });
}

export function retireTimeOffPolicy(id: string) {
  return apiFetch<{ ok: true }>(`/time-off/policies/${id}`, { method: 'DELETE' });
}

export function assignTimeOffPolicy(id: string, assignments: Array<{ scopeKind: TimeOffPolicyScope; scopeId?: string | null }>) {
  return apiFetch<TimeOffPolicyRow>(`/time-off/policies/${id}/assignments`, { method: 'PUT', body: { assignments } });
}
