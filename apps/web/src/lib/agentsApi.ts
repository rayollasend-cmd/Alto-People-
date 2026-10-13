import type {
  AgentApprovalStatus,
  AgentApprovalSummary,
  AgentCredentialIssue,
  AgentDetail,
  AgentInput,
  AgentIssuedCredential,
  AgentRegistryResponse,
  AgentSpendInput,
  AgentSummary,
  AgentUpdate,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The agent registry (Brief 1D-2) — every AI agent Alto runs, with its
 * owner, scopes, credentials, limits, spend and trail. The gated actions
 * an agent may only request sit in the approval queue until a person
 * decides them.
 *
 * Query keys name their inputs:
 *   ['agents', 'list']                 the registry
 *   ['agents', 'detail', id]           one agent, in full
 *   ['agents', 'approvals', filters]   the queue
 */

export type {
  AgentApprovalStatus,
  AgentApprovalSummary,
  AgentCredentialIssue,
  AgentDetail,
  AgentInput,
  AgentIssuedCredential,
  AgentRegistryResponse,
  AgentSpendInput,
  AgentSummary,
  AgentUpdate,
};

export interface AgentApprovalFilters {
  status?: AgentApprovalStatus;
  workerId?: string;
}

export function listAgents(): Promise<AgentRegistryResponse> {
  return apiFetch<AgentRegistryResponse>('/agents');
}

export function getAgent(id: string): Promise<AgentDetail> {
  return apiFetch<AgentDetail>(`/agents/${encodeURIComponent(id)}`);
}

export function createAgent(body: AgentInput): Promise<AgentDetail> {
  return apiFetch<AgentDetail>('/agents', { method: 'POST', body });
}

export function updateAgent(id: string, body: AgentUpdate): Promise<AgentDetail> {
  return apiFetch<AgentDetail>(`/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

/** Register the agents Alto already runs (needs an owner account to exist). */
export interface EnsureBuiltInResult {
  /** Names of the agents registered by this call. */
  created: string[];
  /** Built-in agents still without an owner account. */
  missing: string[];
  profiled: number;
}

export function ensureBuiltInAgents(): Promise<EnsureBuiltInResult> {
  return apiFetch<EnsureBuiltInResult>('/agents/ensure-built-in', { method: 'POST' });
}

/** Issue a short-lived credential. The plaintext comes back once and is never readable again. */
export function issueAgentCredential(id: string, body: AgentCredentialIssue): Promise<AgentIssuedCredential> {
  return apiFetch<AgentIssuedCredential>(`/agents/${encodeURIComponent(id)}/credentials`, { method: 'POST', body });
}

export function revokeAgentCredential(id: string, credentialId: string, reason?: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/agents/${encodeURIComponent(id)}/credentials/${encodeURIComponent(credentialId)}/revoke`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
}

export function recordAgentSpend(id: string, body: AgentSpendInput): Promise<{ id: string; spendThisMonthCents: number }> {
  return apiFetch<{ id: string; spendThisMonthCents: number }>(`/agents/${encodeURIComponent(id)}/spend`, { method: 'POST', body });
}

export function listAgentApprovals(filters: AgentApprovalFilters = {}): Promise<{ approvals: AgentApprovalSummary[] }> {
  const qs = new URLSearchParams();
  if (filters.status) qs.set('status', filters.status);
  if (filters.workerId) qs.set('workerId', filters.workerId);
  const q = qs.toString();
  return apiFetch<{ approvals: AgentApprovalSummary[] }>(`/agents/approvals${q ? `?${q}` : ''}`);
}

export function getAgentApproval(id: string): Promise<AgentApprovalSummary> {
  return apiFetch<AgentApprovalSummary>(`/agents/approvals/${encodeURIComponent(id)}`);
}

export function decideAgentApproval(id: string, decision: 'approve' | 'reject', note?: string): Promise<AgentApprovalSummary> {
  return apiFetch<AgentApprovalSummary>(`/agents/approvals/${encodeURIComponent(id)}/${decision}`, {
    method: 'POST',
    body: note ? { note } : {},
  });
}
