import type {
  AgentProposalSummary,
  HugoNoteKind,
  HugoNoteListResponse,
  HugoNoteSettings,
  HugoNoteView,
  HugoSummary,
  HugoTaskChoice,
  HugoTaskCreateInput,
  HugoTaskListResponse,
  HugoTaskOffer,
  HugoTaskView,
} from '@alto-people/shared';
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
  /** driver: a van driver — their runs, not a rider's ride (floor walk 19). */
  audience: 'associate' | 'driver' | 'manager' | 'admin';
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
  /** Work the person can hand Hugo: a Start card each — nothing starts until they tap it. */
  offers?: HugoTaskOffer[];
  /** The panel shows this tab (the person asked what Hugo is working on). */
  view?: 'tasks' | null;
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

/* ------------------------------------------------- Hugo works for you */

export function listHugoTasks(): Promise<HugoTaskListResponse> {
  return apiFetch<HugoTaskListResponse>('/hugo/tasks');
}

/** The person's tap on Start. Asked twice, the same task comes back (`existing`). */
export function startHugoTask(task: HugoTaskCreateInput, source: 'panel' | 'chat' | 'note' = 'panel'): Promise<{ task: HugoTaskView; existing: boolean }> {
  return apiFetch('/hugo/tasks', { method: 'POST', body: { task, source } });
}

export function cancelHugoTask(id: string): Promise<{ task: HugoTaskView }> {
  return apiFetch(`/hugo/tasks/${id}/cancel`, { method: 'POST', body: {} });
}

export function respondToHugoTask(id: string, choice: HugoTaskChoice): Promise<{ task: HugoTaskView }> {
  return apiFetch(`/hugo/tasks/${id}/respond`, { method: 'POST', body: { choice } });
}

export function listHugoNotes(): Promise<HugoNoteListResponse> {
  return apiFetch<HugoNoteListResponse>('/hugo/notes');
}

export function acceptHugoNote(id: string): Promise<{ note: HugoNoteView; task: HugoTaskView | null; url: string | null }> {
  return apiFetch(`/hugo/notes/${id}/accept`, { method: 'POST', body: {} });
}

export function dismissHugoNote(id: string): Promise<{ note: HugoNoteView }> {
  return apiFetch(`/hugo/notes/${id}/dismiss`, { method: 'POST', body: {} });
}

export function getHugoNoteSettings(): Promise<HugoNoteSettings> {
  return apiFetch<HugoNoteSettings>('/hugo/notes/settings');
}

export function setHugoNoteKind(kind: HugoNoteKind, on: boolean): Promise<HugoNoteSettings> {
  return apiFetch<HugoNoteSettings>('/hugo/notes/settings', { method: 'PUT', body: { kind, on } });
}

/** The person looked at these: they stop counting on the badge. */
export function markHugoSeen(ids: { tasks?: string[]; notes?: string[] }): Promise<{ tasks: number; notes: number }> {
  return apiFetch('/hugo/seen', { method: 'POST', body: ids });
}

export function getHugoSummary(): Promise<HugoSummary> {
  return apiFetch<HugoSummary>('/hugo/summary');
}
