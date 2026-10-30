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
  HugoAskEvent,
  HugoTier,
} from '@alto-people/shared';
import type { HugoMemoryKind, HugoMemoryListResponse, HugoMemoryView, HugoRemembered } from '@alto-people/shared';
import type { HugoActivityPage, HugoRecurringChange } from '@alto-people/shared';
import type { HugoAdminUsage, HugoAllowanceView, HugoProfileView, HugoSavedTurns, HugoThreadView } from '@alto-people/shared';
import { ApiError, apiFetch, apiStream, canStream } from './api';

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
  /** How it was made: the registry at once, the quick model, or the strongest. */
  tier?: HugoTier;
  /** Actions the assistant set up — nothing happens until the person confirms one. */
  actions?: AssistantActionCard[];
  /** Tables a numbers question produced (the report builder, within the person's reach). */
  tables?: AssistantTable[];
  /** Work the person can hand Hugo: a Start card each — nothing starts until they tap it. */
  offers?: HugoTaskOffer[];
  /** The panel shows this tab (the person asked what Hugo is working on). */
  view?: 'tasks' | null;
  /** The ids the server kept the question and the answer under (the conversation follows the account). */
  turns?: HugoSavedTurns | null;
  /** Set when the person's allowance for Hugo's thinking is used up: the reply already says until when. */
  allowance?: { exhausted: true; renewsAt: string } | null;
  /** What Hugo kept from this answer (the chip under it: "Saved to what Hugo knows · Undo"). */
  remembered?: HugoRemembered[];
  /** How many kept things this answer forgot. */
  forgot?: number;
  /** The first time Hugo kept anything for this person (the answer says where it lives). */
  memoryFirst?: boolean;
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

/**
 * Ask. With `onEvent` the answer is shown as it is made (POST
 * /hugo/ask/stream): each step and the words as they come, then the whole
 * answer resolves as before. A browser or server that can't stream asks the
 * plain way (POST /hugo/ask) — same answer, all at once.
 */
export function askHugo(
  text: string,
  opts: { page?: AssistantPage | null; history?: AssistantTurn[]; onEvent?: (e: Exclude<HugoAskEvent, { t: 'done' | 'error' }>) => void } = {},
): Promise<HugoAnswer> {
  const body = { text, page: opts.page ?? null, history: opts.history ?? [] };
  if (opts.onEvent && canStream()) return askLive(body, opts.onEvent);
  return apiFetch<HugoAnswer>('/hugo/ask', { method: 'POST', body });
}

async function askLive(body: { text: string; page: AssistantPage | null; history: AssistantTurn[] }, onEvent: (e: Exclude<HugoAskEvent, { t: 'done' | 'error' }>) => void): Promise<HugoAnswer> {
  let answer: HugoAnswer | null = null;
  let failed: string | null = null;
  let heard = false;
  try {
    await apiStream('/hugo/ask/stream', body, (line) => {
      const e = line as HugoAskEvent;
      heard = true;
      if (e.t === 'done') answer = e.answer as unknown as HugoAnswer;
      else if (e.t === 'error') failed = e.message;
      else onEvent(e);
    });
  } catch (err) {
    // Nothing said yet and the stream itself is the problem (an older server
    // without it, a browser or proxy that can't read one): ask the plain way.
    // A refusal (403, 409, a bad question) is the answer either way.
    const plain = !heard && (!(err instanceof ApiError) || err.status === 404);
    if (plain) return apiFetch<HugoAnswer>('/hugo/ask', { method: 'POST', body });
    throw err;
  }
  if (answer) return answer;
  throw new ApiError(502, 'stream_cut', failed ?? 'The answer was cut off. Ask again.');
}

/** The person's tap on a confirmation card (or Cancel). Runs once, as them. */
export function decideAssistantAction(token: string, decision: 'confirm' | 'cancel'): Promise<ActionResult> {
  return apiFetch<ActionResult>('/hugo/confirm', { method: 'POST', body: { token, decision } });
}

export function handoffToPerson(text: string): Promise<{ reply: string; linkUrl: string | null; sent: boolean; turn?: { id: string; createdAt: string } | null }> {
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

/* ------------------------------------------------- What Hugo knows */

export function getHugoMemory(): Promise<HugoMemoryListResponse> {
  return apiFetch<HugoMemoryListResponse>('/hugo/memory');
}

/** The person adds one. A refusal is a 422 whose details say why ({ reason }). */
export function addHugoMemory(text: string, kind: HugoMemoryKind): Promise<{ fact: HugoMemoryView; existing: boolean }> {
  return apiFetch('/hugo/memory', { method: 'POST', body: { text, kind } });
}

export function editHugoMemory(id: string, patch: { text?: string; kind?: HugoMemoryKind }): Promise<{ fact: HugoMemoryView }> {
  return apiFetch(`/hugo/memory/${id}`, { method: 'PATCH', body: patch });
}

/** Remove one — from the list, or the Undo under an answer. */
export function removeHugoMemory(id: string, via: 'list' | 'undo' = 'list'): Promise<{ ok: true }> {
  return apiFetch(`/hugo/memory/${id}${via === 'undo' ? '?via=undo' : ''}`, { method: 'DELETE' });
}

/** Forget everything (after the person confirmed it). */
export function forgetAllHugoMemory(): Promise<{ forgot: number }> {
  return apiFetch('/hugo/memory', { method: 'DELETE', body: { confirm: true } });
}

export function setHugoMemoryOn(memoryOn: boolean): Promise<{ memoryOn: boolean }> {
  return apiFetch('/hugo/memory/settings', { method: 'PUT', body: { memoryOn } });
}

/* ------------------------------------- recurring briefs and the activity log */

/** Pause, resume or change when a recurring brief comes (stopping is cancelHugoTask). */
export function changeHugoRecurring(id: string, change: HugoRecurringChange): Promise<{ task: HugoTaskView }> {
  return apiFetch(`/hugo/recurring/${id}`, { method: 'PATCH', body: change });
}

/** Everything Hugo did for the person, newest first; pass the last page's `next` as `before`. */
export function listHugoActivity(before: string | null = null, limit = 30): Promise<HugoActivityPage> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set('before', before);
  return apiFetch<HugoActivityPage>(`/hugo/activity?${q.toString()}`);
}

/* ------------------------------------- one Hugo per account */

/** The person's own conversation, on every device they sign in on (the last 50 turns). */
export function getHugoThread(): Promise<HugoThreadView> {
  return apiFetch<HugoThreadView>('/hugo/thread');
}

/** "Start over" — for every device. */
export function clearHugoThread(): Promise<{ clearedAt: string; removed: number }> {
  return apiFetch('/hugo/thread', { method: 'DELETE' });
}

export function getHugoProfile(): Promise<HugoProfileView> {
  return apiFetch<HugoProfileView>('/hugo/profile');
}

/** Read answers aloud — follows the account. */
export function setHugoReadAloud(readAloud: boolean): Promise<HugoProfileView> {
  return apiFetch<HugoProfileView>('/hugo/profile', { method: 'PATCH', body: { readAloud } });
}

/** Where the person's own allowance for Hugo's thinking stands this month. */
export function getHugoAllowance(): Promise<HugoAllowanceView> {
  return apiFetch<HugoAllowanceView>('/hugo/allowance');
}

/** manage:org — this month's spend on Hugo's thinking for the organization. */
export function getHugoAdminUsage(): Promise<HugoAdminUsage> {
  return apiFetch<HugoAdminUsage>('/hugo/admin/usage');
}
