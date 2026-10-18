import type { AgentProposalSummary } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The assistant's API. One registry answers everywhere (payday, ride,
 * schedule, documents for a worker; coverage and the desk for staff); with
 * a model behind it the same answers become its tools and it knows the
 * page the person is on. It never acts on its own: a hand-off to a person
 * is OFFERED (`handoff` on the answer), and an action is PROPOSED as a
 * confirmation card (`actions`) that runs only on the person's own Confirm.
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
  /** Actions the assistant set up — nothing happens until the person confirms one. */
  actions?: AssistantActionCard[];
  /** Tables a numbers question produced (the report builder, within the person's reach). */
  tables?: AssistantTable[];
}

export interface AssistantActionCard {
  id: string;
  token: string;
  kind: string;
  title: string;
  detail: string | null;
  confirmLabel: string;
  expiresAt: string;
}

export interface AssistantTable {
  title: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  linkUrl: string;
}

export interface ActionResult {
  status: 'done' | 'pending_approval' | 'cancelled' | 'failed';
  title: string;
  message: string;
  linkUrl: string | null;
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

/** The person's tap on a confirmation card (or Cancel). Runs once, as them. */
export function decideAssistantAction(token: string, decision: 'confirm' | 'cancel'): Promise<ActionResult> {
  return apiFetch<ActionResult>('/hugo/confirm', { method: 'POST', body: { token, decision } });
}

export function handoffToPerson(text: string): Promise<{ reply: string; linkUrl: string | null; sent: boolean }> {
  return apiFetch('/hugo/handoff', { method: 'POST', body: { text } });
}

export function listProposals(filter: { status?: string } = {}): Promise<{ proposals: AgentProposalSummary[] }> {
  const q = filter.status ? `?status=${encodeURIComponent(filter.status)}` : '';
  return apiFetch<{ proposals: AgentProposalSummary[] }>(`/agents/proposals${q}`);
}
