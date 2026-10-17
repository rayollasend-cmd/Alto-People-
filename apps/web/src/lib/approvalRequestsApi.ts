import type {
  AccessGrant,
  AccessGrantInput,
  ApprovalDecideInput,
  ApprovalDelegation,
  ApprovalDelegationInput,
  ApprovalRequestKind,
  ApprovalRequestStatus,
  ApprovalRequestSummary,
  PayChangeRow,
  PendingApprovalResponse,
  Promotion,
  PromotionInput,
  WorkflowTask,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The approval engine ("maker-checker"): a change that needs a second
 * person waits as a request; the second person decides it and the change
 * lands under their name.
 *
 *   GET  /approvals/requests?scope=decide|mine|all   the queue
 *   POST /approvals/requests/:id/decide              { decision, reason? }
 *   POST /approvals/requests/:id/cancel              the requester withdraws
 *   GET  /approvals/pay-changes                      Finance's view of pay and bill-rate changes
 *   /approvals/delegations                           "decide mine while I'm out"
 *   /promotions, /admin/access-grants, /workflows/tasks
 *
 * A route that sent a change to a second person answers 202 with
 * { pending: true, approvalId, title }: isPending() tells the two apart.
 */

export type { ApprovalRequestSummary, ApprovalDelegation, AccessGrant, Promotion, PayChangeRow, WorkflowTask, PendingApprovalResponse };

export const MY_REQUESTS_KEY = ['approvals', 'requests'] as const;

/** Did the server park the change for a second person instead of applying it? */
export function isPending(r: unknown): r is PendingApprovalResponse {
  return !!r && typeof r === 'object' && (r as { pending?: unknown }).pending === true && typeof (r as { approvalId?: unknown }).approvalId === 'string';
}

/** The full record's filters (scope=all). */
export interface RecordFilters {
  kind?: ApprovalRequestKind;
  status?: ApprovalRequestStatus;
  requesterUserId?: string;
  approverUserId?: string;
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
}

export function listApprovalRequests(scope: 'decide' | 'mine' | 'all' = 'decide', filters: RecordFilters | ApprovalRequestStatus = {}): Promise<{ requests: ApprovalRequestSummary[] }> {
  const f: RecordFilters = typeof filters === 'string' ? { status: filters } : filters;
  const sp = new URLSearchParams({ scope });
  for (const [k, v] of Object.entries(f)) if (v) sp.set(k, String(v));
  return apiFetch<{ requests: ApprovalRequestSummary[] }>(`/approvals/requests?${sp.toString()}`);
}

export function decideApprovalRequest(id: string, input: ApprovalDecideInput): Promise<ApprovalRequestSummary> {
  return apiFetch<ApprovalRequestSummary>(`/approvals/requests/${encodeURIComponent(id)}/decide`, { method: 'POST', body: input });
}

export function cancelApprovalRequest(id: string): Promise<ApprovalRequestSummary> {
  return apiFetch<ApprovalRequestSummary>(`/approvals/requests/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

export function listPayChanges(filters: { associateId?: string; clientId?: string } = {}): Promise<{ changes: PayChangeRow[] }> {
  const sp = new URLSearchParams();
  if (filters.associateId) sp.set('associateId', filters.associateId);
  if (filters.clientId) sp.set('clientId', filters.clientId);
  const qs = sp.toString();
  return apiFetch<{ changes: PayChangeRow[] }>(`/approvals/pay-changes${qs ? `?${qs}` : ''}`);
}

export function listMyDelegations(): Promise<{ given: ApprovalDelegation[]; covering: ApprovalDelegation[] }> {
  return apiFetch('/approvals/delegations/mine');
}

export function createDelegation(input: ApprovalDelegationInput): Promise<ApprovalDelegation> {
  return apiFetch<ApprovalDelegation>('/approvals/delegations', { method: 'POST', body: input });
}

export function endDelegation(id: string): Promise<void> {
  return apiFetch<void>(`/approvals/delegations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listPromotions(filters: { associateId?: string } = {}): Promise<{ promotions: Promotion[] }> {
  const qs = filters.associateId ? `?associateId=${encodeURIComponent(filters.associateId)}` : '';
  return apiFetch<{ promotions: Promotion[] }>(`/promotions${qs}`);
}

export function proposePromotion(input: PromotionInput): Promise<Promotion> {
  return apiFetch<Promotion>('/promotions', { method: 'POST', body: input });
}

export function listAccessGrants(filters: { userId?: string; open?: boolean } = {}): Promise<{ grants: AccessGrant[] }> {
  const sp = new URLSearchParams();
  if (filters.userId) sp.set('userId', filters.userId);
  if (filters.open) sp.set('open', 'true');
  const qs = sp.toString();
  return apiFetch<{ grants: AccessGrant[] }>(`/admin/access-grants${qs ? `?${qs}` : ''}`);
}

export function grantAccess(input: AccessGrantInput): Promise<AccessGrant> {
  return apiFetch<AccessGrant>('/admin/access-grants', { method: 'POST', body: input });
}

export function revertAccessGrant(id: string): Promise<AccessGrant> {
  return apiFetch<AccessGrant>(`/admin/access-grants/${encodeURIComponent(id)}/revert`, { method: 'POST' });
}

export function listWorkflowTasks(status: 'OPEN' | 'DONE' = 'OPEN'): Promise<{ tasks: WorkflowTask[] }> {
  return apiFetch<{ tasks: WorkflowTask[] }>(`/workflows/tasks?status=${status}`);
}

export function finishWorkflowTask(id: string): Promise<WorkflowTask> {
  return apiFetch<WorkflowTask>(`/workflows/tasks/${encodeURIComponent(id)}/done`, { method: 'POST' });
}

/** The query keys a decision changes: the queue, the badge, and the records a decision writes. */
export const APPROVAL_DECISION_INVALIDATES: ReadonlyArray<readonly string[]> = [MY_REQUESTS_KEY, ['approvals', 'count'], ['inbox'], ['comp-records'], ['positions'], ['separations'], ['admin', 'users'], ['promotions']];
