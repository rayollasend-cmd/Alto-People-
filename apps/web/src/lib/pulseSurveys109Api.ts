import { apiFetch } from './api';

export type PulseScale = 'SCORE_1_5' | 'YES_NO';
export type PulseAudience = 'ALL' | 'BY_DEPARTMENT' | 'BY_CLIENT';

export interface PulseSurveyAdmin {
  id: string;
  question: string;
  scale: PulseScale;
  audience: PulseAudience;
  audienceLabel: string | null;
  openFrom: string;
  openUntil: string;
  isOpen: boolean;
  responseCount: number;
  createdAt: string;
}

export interface PulseSurveyOpen {
  id: string;
  question: string;
  scale: PulseScale;
  openUntil: string;
}

export interface PulseResults {
  survey: {
    id: string;
    question: string;
    scale: PulseScale;
    openUntil: string;
  };
  responseCount: number;
  average: number | null;
  distribution: Record<string, number>;
  comments: { comment: string; submittedAt: string }[];
}

export const listPulseSurveys = () =>
  apiFetch<{ surveys: PulseSurveyAdmin[] }>('/pulse-surveys');

export const createPulseSurvey = (input: {
  question: string;
  scale: PulseScale;
  audience: PulseAudience;
  audienceDepartmentId?: string | null;
  audienceClientId?: string | null;
  openHours?: number;
}) =>
  apiFetch<{ id: string }>('/pulse-surveys', { method: 'POST', body: input });

export const deletePulseSurvey = (id: string) =>
  apiFetch<void>(`/pulse-surveys/${id}`, { method: 'DELETE' });

export const getPulseResults = (id: string) =>
  apiFetch<PulseResults>(`/pulse-surveys/${id}/results`);

export const listMyOpenSurveys = () =>
  apiFetch<{ surveys: PulseSurveyOpen[] }>('/my/pulse-surveys');

export const submitPulseResponse = (
  id: string,
  input: { scoreValue: number; comment?: string | null },
) =>
  apiFetch<{ ok: true }>(`/my/pulse-surveys/${id}/respond`, {
    method: 'POST',
    body: input,
  });
