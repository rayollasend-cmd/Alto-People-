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

export interface Broadcast {
  id: string;
  title: string;
  body: string;
  channels: BroadcastChannel[];
  status: BroadcastStatus;
  clientId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  receiptCount: number;
  createdAt: string;
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
export const createBroadcast = (input: {
  title: string;
  body: string;
  channels?: BroadcastChannel[];
  clientId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  scheduledFor?: string | null;
}) => apiFetch<{ id: string }>('/broadcasts', { method: 'POST', body: input });
export const sendBroadcast = (id: string) =>
  apiFetch<{ recipientCount: number }>(`/broadcasts/${id}/send`, {
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
export const submitSurveyResponse = (
  surveyId: string,
  answers: Array<{
    questionId: string;
    textValue?: string | null;
    intValue?: number | null;
    choiceValues?: number[];
  }>,
) =>
  apiFetch<{ ok: true }>(`/surveys/${surveyId}/responses`, {
    method: 'POST',
    body: { answers },
  });
export const getSurveyAggregate = (surveyId: string) =>
  apiFetch<SurveyAggregate>(`/surveys/${surveyId}/responses`);
