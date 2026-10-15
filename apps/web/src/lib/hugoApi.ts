import type { AgentProposalSummary } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Hugo in the app (agent families step 3): the same intent registry as
 * WhatsApp, answered from the asker's own records or desk.
 *
 * Query keys name their inputs:
 *   ['hugo', 'me']                  who he is and what he can do for this session
 *   ['agents', 'proposals', filter] the agents' latest proposals (what they are doing)
 */

export interface HugoCan {
  key: string;
  label: string;
  example: string;
}

export interface HugoMe {
  name: string;
  audience: 'associate' | 'manager' | 'admin';
  intro: string;
  can: HugoCan[];
}

export interface HugoAnswer {
  intent: string;
  reply: string;
  linkUrl: string | null;
}

export function getHugo(): Promise<HugoMe> {
  return apiFetch<HugoMe>('/hugo');
}

export function askHugo(text: string): Promise<HugoAnswer> {
  return apiFetch<HugoAnswer>('/hugo/ask', { method: 'POST', body: { text } });
}

export function listProposals(filter: { status?: string } = {}): Promise<{ proposals: AgentProposalSummary[] }> {
  const q = filter.status ? `?status=${encodeURIComponent(filter.status)}` : '';
  return apiFetch<{ proposals: AgentProposalSummary[] }>(`/agents/proposals${q}`);
}
