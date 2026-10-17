import type { AgentApprovalSummary, AgentDecideInput, ProposalEvidence } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Agent proposals as decisions ("agents propose, people decide").
 *
 *   GET  /approvals/proposals            the proposals waiting on the signed-in
 *                                        person — already filtered to what the
 *                                        server's rule lets them decide, so a site
 *                                        supervisor without view:org sees their own
 *   POST /agents/approvals/:id/decide    { decision: APPROVE | REJECT, reason? }
 *                                        one decision; a rejection says why
 *
 * Query keys:
 *   ['approvals', 'proposals']   the caller's queue (the Approvals page, the badge invalidates it)
 *   ['agents', 'approvals', …]   the registry's queue (the Agents page) — a decision invalidates both
 */

export type { AgentApprovalSummary, AgentDecideInput, ProposalEvidence };

export const MY_PROPOSALS_KEY = ['approvals', 'proposals'] as const;

export function listMyProposals(): Promise<{ approvals: AgentApprovalSummary[] }> {
  return apiFetch<{ approvals: AgentApprovalSummary[] }>('/approvals/proposals');
}

export function decideProposal(id: string, input: AgentDecideInput): Promise<AgentApprovalSummary> {
  return apiFetch<AgentApprovalSummary>(`/agents/approvals/${encodeURIComponent(id)}/decide`, { method: 'POST', body: input });
}

/** The query keys a decision changes: every queue that shows proposals, and the badge. */
export const PROPOSAL_DECISION_INVALIDATES: ReadonlyArray<readonly string[]> = [MY_PROPOSALS_KEY, ['agents'], ['approvals', 'count'], ['inbox']];
