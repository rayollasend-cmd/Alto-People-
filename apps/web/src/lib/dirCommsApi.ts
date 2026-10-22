import { apiFetch } from './api';

export interface Person {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  managerId: string | null;
  department: string | null;
  jobTitle: string | null;
}

export type BroadcastStatus = 'DRAFT' | 'SCHEDULED' | 'SENT' | 'CANCELLED';
export type BroadcastChannel = 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH';

export type BroadcastOutcome = 'sent' | 'failed' | 'muted' | 'suppressed' | 'not_configured' | 'held' | 'skipped' | 'no_phone';

export interface BroadcastDelivery {
  channels: BroadcastChannel[];
  counts: Partial<Record<BroadcastChannel, Partial<Record<BroadcastOutcome, number>>>>;
  /** Why a channel sent nothing at all (no provider behind it). */
  notConfigured: Partial<Record<BroadcastChannel, string>>;
  recipients: number;
  finishedAt: string;
}

const CHANNEL_NOUN: Record<BroadcastChannel, string> = { IN_APP: 'In-app', EMAIL: 'Email', SMS: 'Texts', PUSH: 'Push' };

/**
 * One line per chosen channel that tells the truth about what left:
 * "Texts: not connected", "Email: 212 sent · 3 muted", "In-app: 215".
 * Null while the fan-out is still running.
 */
export function deliveryLines(d: BroadcastDelivery | null | undefined): Array<{ channel: BroadcastChannel; text: string; problem: boolean }> {
  if (!d) return [];
  return d.channels.map((channel) => {
    const noun = CHANNEL_NOUN[channel];
    const off = d.notConfigured[channel];
    if (off) return { channel, text: `${noun}: not connected — nothing sent`, problem: true };
    const c = d.counts[channel] ?? {};
    const parts: string[] = [`${c.sent ?? 0} sent`];
    if (c.failed) parts.push(`${c.failed} failed`);
    if (c.suppressed) parts.push(`${c.suppressed} opted out`);
    if (c.muted) parts.push(`${c.muted} muted`);
    if (c.held) parts.push(`${c.held} held for quiet hours`);
    if (c.no_phone) parts.push(`${c.no_phone} no phone`);
    if (c.not_configured) parts.push(`${c.not_configured} not set up`);
    return { channel, text: `${noun}: ${parts.join(' · ')}`, problem: (c.sent ?? 0) === 0 && (((c.failed ?? 0) + (c.suppressed ?? 0) + (c.not_configured ?? 0)) > 0) };
  });
}

export interface Broadcast {
  id: string;
  title: string;
  body: string;
  channels: BroadcastChannel[];
  status: BroadcastStatus;
  clientId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  /** "Message selected" on People: the explicit list (targeting unused when set). */
  recipientAssociateIds?: string[];
  scheduledFor: string | null;
  sentAt: string | null;
  receiptCount: number;
  /** What left per chosen channel after send-now; null until the fan-out finishes (or for drafts). */
  delivery?: BroadcastDelivery | null;
  createdAt: string;
  /** Set = a saved template (never sent). */
  templateName?: string | null;
  createdByEmail?: string | null;
  createdByRole?: string | null;
}

/** Who a targeting reaches — the send confirm names these numbers. */
export interface BroadcastAudience {
  people: number;
  /** Has an account: what in-app and push reach. */
  withAccount: number;
  /** Has a phone: what SMS reaches. */
  withPhone: number;
  withEmail: number;
}

export interface MyBroadcast {
  id: string;
  title: string;
  body: string;
  sentAt: string | null;
  channels: BroadcastChannel[];
  readAt: string | null;
  dismissedAt: string | null;
}

export type SurveyStatus = 'DRAFT' | 'OPEN' | 'CLOSED';
export type SurveyQuestionKind =
  | 'SHORT_TEXT'
  | 'LONG_TEXT'
  | 'SINGLE_CHOICE'
  | 'MULTI_CHOICE'
  | 'SCALE_1_5'
  | 'NPS_0_10';

export interface Survey {
  id: string;
  title: string;
  description: string | null;
  status: SurveyStatus;
  isAnonymous: boolean;
  clientId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  questionCount: number;
  responseCount: number;
}

export interface SurveyQuestion {
  id: string;
  surveyId: string;
  kind: SurveyQuestionKind;
  prompt: string;
  choices: string[] | null;
  isRequired: boolean;
  sortOrder: number;
}

export interface SurveyAggregate {
  survey: { id: string; title: string; isAnonymous: boolean; status: SurveyStatus };
  responseCount: number;
  byQuestion: Array<{
    questionId: string;
    prompt: string;
    kind: SurveyQuestionKind;
    count: number;
    avg?: number | null;
    tally?: Record<number, number>;
    choices?: unknown;
    samples?: (string | null)[];
  }>;
}

export const searchDirectory = (q?: string) =>
  apiFetch<{ people: Person[] }>(q ? `/directory?q=${encodeURIComponent(q)}` : '/directory');

export const listBroadcasts = () =>
  apiFetch<{ broadcasts: Broadcast[] }>('/broadcasts');
export const listBroadcastTemplates = () =>
  apiFetch<{ broadcasts: Broadcast[] }>('/broadcasts?templates=1');
export const broadcastAudienceCount = (t: { clientId?: string | null; departmentId?: string | null; costCenterId?: string | null; recipientAssociateIds?: string[] }) =>
  apiFetch<BroadcastAudience>('/broadcasts/audience-count', { method: 'POST', body: t });
export const savedBroadcastAudience = (id: string) => apiFetch<BroadcastAudience>(`/broadcasts/${id}/audience-count`);
export const duplicateBroadcast = (id: string) => apiFetch<{ id: string }>(`/broadcasts/${id}/duplicate`, { method: 'POST', body: {} });
export const saveBroadcastAsTemplate = (id: string, name: string) =>
  apiFetch<{ id: string }>(`/broadcasts/${id}/template`, { method: 'POST', body: { name } });
export const deleteBroadcast = (id: string) => apiFetch<void>(`/broadcasts/${id}`, { method: 'DELETE' });
export const createBroadcast = (input: {
  title: string;
  body: string;
  channels?: BroadcastChannel[];
  clientId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  scheduledFor?: string | null;
  recipientAssociateIds?: string[];
}) => apiFetch<{ id: string }>('/broadcasts', { method: 'POST', body: input });
export const updateBroadcast = (
  id: string,
  input: Partial<{
    title: string;
    body: string;
    channels: BroadcastChannel[];
    clientId: string | null;
    departmentId: string | null;
    costCenterId: string | null;
    scheduledFor: string | null;
    recipientAssociateIds: string[];
  }>,
) =>
  apiFetch<{ ok: true }>(`/broadcasts/${id}`, { method: 'PUT', body: input });
export const sendBroadcast = (id: string) =>
  apiFetch<{ recipientCount: number; phoneCount?: number; channels?: BroadcastChannel[]; notConfigured?: Partial<Record<BroadcastChannel, string>> }>(`/broadcasts/${id}/send`, {
    method: 'POST',
    body: {},
  });
export const myBroadcasts = () =>
  apiFetch<{ broadcasts: MyBroadcast[] }>('/broadcasts/me');
export const markBroadcastRead = (id: string) =>
  apiFetch<{ ok: true }>(`/broadcasts/${id}/read`, { method: 'POST', body: {} });

export const listSurveys = () =>
  apiFetch<{ surveys: Survey[] }>('/surveys');
export const createSurvey = (input: {
  title: string;
  description?: string | null;
  isAnonymous?: boolean;
  clientId?: string | null;
}) => apiFetch<{ id: string }>('/surveys', { method: 'POST', body: input });
export const listSurveyQuestions = (surveyId: string) =>
  apiFetch<{ questions: SurveyQuestion[] }>(`/surveys/${surveyId}/questions`);
export const addSurveyQuestion = (
  surveyId: string,
  input: {
    kind: SurveyQuestionKind;
    prompt: string;
    choices?: string[];
    isRequired?: boolean;
    sortOrder?: number;
  },
) =>
  apiFetch<{ id: string }>(`/surveys/${surveyId}/questions`, {
    method: 'POST',
    body: input,
  });
export const openSurvey = (id: string) =>
  apiFetch<{ ok: true }>(`/surveys/${id}/open`, { method: 'POST', body: {} });
export const closeSurvey = (id: string) =>
  apiFetch<{ ok: true }>(`/surveys/${id}/close`, { method: 'POST', body: {} });
export const getSurveyAggregate = (surveyId: string) =>
  apiFetch<SurveyAggregate>(`/surveys/${surveyId}/responses`);
