import type {
  AgentApprovalStatus,
  AgentCapabilitySummary,
  CapabilityScorecard,
  AgentApprovalSummary,
  AgentCertification,
  AgentControlState,
  AgentCredentialIssue,
  AgentDetail,
  AgentDrift,
  AgentInput,
  AgentIssuedCredential,
  AgentRegistryResponse,
  AgentScenarioInput,
  AgentScenarioSummary,
  AgentScorecard,
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
 * Brief 1D-3 adds the controls: the kill switch (one agent or all of
 * them), certification scenarios, the scorecard and drift thresholds.
 *
 * Query keys name their inputs:
 *   ['agents', 'list']                 the registry (carries `control`)
 *   ['agents', 'detail', id]           one agent, in full
 *   ['agents', 'approvals', filters]   the queue
 *   ['agents', 'control']              the global switch
 *   ['agents', 'scenarios', id]        one agent's certification scenarios
 *   ['agents', 'scorecard', id, days]  one agent's scorecard for a window
 */

export type {
  AgentApprovalStatus,
  AgentApprovalSummary,
  AgentCertification,
  AgentControlState,
  AgentCredentialIssue,
  AgentDetail,
  AgentDrift,
  AgentInput,
  AgentIssuedCredential,
  AgentRegistryResponse,
  AgentScenarioInput,
  AgentScenarioSummary,
  AgentScorecard,
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

/* ------------------------------------------------- Brief 1D-3: controls */

/** The global switch. */
export function getAgentControl(): Promise<AgentControlState> {
  return apiFetch<AgentControlState>('/agents/control');
}

/** Suspend every agent at once; every live credential is revoked. */
export function suspendAllAgents(reason: string): Promise<{ revoked: number; agents: number }> {
  return apiFetch<{ revoked: number; agents: number }>('/agents/suspend-all', { method: 'POST', body: { reason } });
}

export function resumeAllAgents(): Promise<AgentControlState> {
  return apiFetch<AgentControlState>('/agents/resume-all', { method: 'POST' });
}

/** Suspend one agent; its credentials are revoked in the same transaction. */
export function suspendAgent(id: string, reason: string): Promise<{ revoked: number; agent: AgentDetail }> {
  return apiFetch<{ revoked: number; agent: AgentDetail }>(`/agents/${encodeURIComponent(id)}/suspend`, { method: 'POST', body: { reason } });
}

/** The owner's to do (403 `owner_only` otherwise). No credential comes back. */
export function resumeAgent(id: string): Promise<AgentDetail> {
  return apiFetch<AgentDetail>(`/agents/${encodeURIComponent(id)}/resume`, { method: 'POST' });
}

export function listAgentScenarios(id: string): Promise<{ scenarios: AgentScenarioSummary[] }> {
  return apiFetch<{ scenarios: AgentScenarioSummary[] }>(`/agents/${encodeURIComponent(id)}/scenarios`);
}

export function addAgentScenario(id: string, input: AgentScenarioInput): Promise<AgentScenarioSummary> {
  return apiFetch<AgentScenarioSummary>(`/agents/${encodeURIComponent(id)}/scenarios`, { method: 'POST', body: input });
}

export function removeAgentScenario(id: string, scenarioId: string): Promise<void> {
  return apiFetch<void>(`/agents/${encodeURIComponent(id)}/scenarios/${encodeURIComponent(scenarioId)}`, { method: 'DELETE' });
}

/** Built-in agents only (409 `agent_answers_itself` for the rest). */
export function runAgentScenarios(id: string): Promise<{ ran: number; passed: number; scenarios: AgentScenarioSummary[] }> {
  return apiFetch<{ ran: number; passed: number; scenarios: AgentScenarioSummary[] }>(`/agents/${encodeURIComponent(id)}/scenarios/run`, { method: 'POST' });
}

/** 409 `agent_not_certified` (with the reason in the message) when not every scenario passes. */
export function certifyAgent(id: string): Promise<{ certification: AgentCertification; agent: AgentDetail }> {
  return apiFetch<{ certification: AgentCertification; agent: AgentDetail }>(`/agents/${encodeURIComponent(id)}/certify`, { method: 'POST' });
}

export function getAgentScorecard(id: string, days: number): Promise<AgentScorecard> {
  return apiFetch<AgentScorecard>(`/agents/${encodeURIComponent(id)}/scorecard?days=${encodeURIComponent(String(days))}`);
}

export type AgentDriftInput = Partial<Pick<AgentDrift, 'driftErrorRatePct' | 'driftCostPerTaskCents'>>;

export function updateAgentDrift(id: string, input: AgentDriftInput): Promise<AgentDetail> {
  return apiFetch<AgentDetail>(`/agents/${encodeURIComponent(id)}/drift`, { method: 'PATCH', body: input });
}

/* ------------------------------------------- agent families: capabilities */

/** The agent's capabilities: on/off, suspension, and whether the tenant offers each (its modules). */
export function listAgentCapabilities(id: string): Promise<{ capabilities: AgentCapabilitySummary[] }> {
  return apiFetch<{ capabilities: AgentCapabilitySummary[] }>(`/agents/${encodeURIComponent(id)}/capabilities`);
}

export function getCapabilityScorecard(id: string, key: string, days: number): Promise<CapabilityScorecard> {
  return apiFetch<CapabilityScorecard>(
    `/agents/${encodeURIComponent(id)}/capabilities/${encodeURIComponent(key)}/scorecard?days=${encodeURIComponent(String(days))}`,
  );
}

export function suspendAgentCapability(id: string, key: string, reason: string): Promise<AgentCapabilitySummary> {
  return apiFetch<AgentCapabilitySummary>(`/agents/${encodeURIComponent(id)}/capabilities/${encodeURIComponent(key)}/suspend`, {
    method: 'POST',
    body: { reason },
  });
}

/** The accountable owner only (403 `owner_only` for anyone else). */
export function resumeAgentCapability(id: string, key: string): Promise<AgentCapabilitySummary> {
  return apiFetch<AgentCapabilitySummary>(`/agents/${encodeURIComponent(id)}/capabilities/${encodeURIComponent(key)}/resume`, { method: 'POST' });
}
