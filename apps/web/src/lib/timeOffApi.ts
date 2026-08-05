import type {
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

export function listAdminRequests(status?: TimeOffRequestStatus) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch<TimeOffRequestListResponse>(`/time-off/admin/requests${qs}`);
}

export function approveAdminRequest(id: string, note?: string) {
  return apiFetch<TimeOffRequestResponse>(
    `/time-off/admin/requests/${id}/approve`,
    {
      method: 'POST',
      body: { note },
    }
  );
}

export function denyAdminRequest(id: string, input: TimeOffRequestDenyInput) {
  return apiFetch<TimeOffRequestResponse>(
    `/time-off/admin/requests/${id}/deny`,
    {
      method: 'POST',
      body: input,
    }
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
