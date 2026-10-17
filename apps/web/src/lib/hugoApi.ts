import type { AgentProposalSummary } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The assistant's API. One registry answers everywhere (payday, ride,
 * schedule, documents for a worker; coverage and the desk for staff); with
 * a model behind it the same answers become its tools and it knows the
 * page the person is on. It never acts: a hand-off to a person is OFFERED
 * (`handoff` on the answer) and sent only when the person confirms.
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
  /** A model answers (not only the registry's rules). */
  model?: boolean;
}

export interface HugoAnswer {
  intent: string;
  reply: string;
  linkUrl: string | null;
  /** The assistant offered to pass this to a person; confirm with `handoffToPerson`. */
  handoff?: { summary: string; who: string | null } | null;
  source?: 'model' | 'rules';
}

export interface AssistantPage {
  path: string;
  title?: string | null;
  record?: { type: string; id: string; name: string } | null;
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

export function getHugo(): Promise<HugoMe> {
  return apiFetch<HugoMe>('/hugo');
}

export function askHugo(text: string, opts: { page?: AssistantPage | null; history?: AssistantTurn[] } = {}): Promise<HugoAnswer> {
  return apiFetch<HugoAnswer>('/hugo/ask', { method: 'POST', body: { text, page: opts.page ?? null, history: opts.history ?? [] } });
}

export function handoffToPerson(text: string): Promise<{ reply: string; linkUrl: string | null; sent: boolean }> {
  return apiFetch('/hugo/handoff', { method: 'POST', body: { text } });
}

export function listProposals(filter: { status?: string } = {}): Promise<{ proposals: AgentProposalSummary[] }> {
  const q = filter.status ? `?status=${encodeURIComponent(filter.status)}` : '';
  return apiFetch<{ proposals: AgentProposalSummary[] }>(`/agents/proposals${q}`);
}
