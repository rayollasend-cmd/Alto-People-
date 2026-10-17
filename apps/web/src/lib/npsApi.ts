import { apiFetch } from './api';

/** Client NPS: the quarterly question to store managers, and what came back. */

export interface NpsResults {
  current: {
    waveId: string;
    quarter: string;
    sentAt: string;
    closesAt: string;
    open: boolean;
    invited: number;
    responded: number;
    responsePct: number | null;
    nps: number | null;
    promoters: number;
    passives: number;
    detractors: number;
  } | null;
  byClient: Array<{
    clientId: string;
    clientName: string;
    invited: number;
    responded: number;
    nps: number | null;
    avgScore: number | null;
    previousNps: number | null;
    lastComment: string | null;
  }>;
  trend: Array<{ quarter: string; nps: number | null; responded: number; invited: number }>;
  comments: Array<{ clientName: string; score: number; comment: string; at: string }>;
  canSendQuarter: string | null;
}

export const getNpsResults = () => apiFetch<NpsResults>('/executive/nps');
export const sendNpsWave = (quarter?: string) =>
  apiFetch<{ waveId: string; quarter: string; invited: number }>('/executive/nps/send', { method: 'POST', body: quarter ? { quarter } : {} });
export const remindNpsWave = () => apiFetch<{ reminded: number }>('/executive/nps/remind', { method: 'POST' });

/* ===== The answer page (no login) ========================================= */

export interface NpsInvite {
  orgName: string;
  clientName: string;
  quarter: string;
  closed: boolean;
  answered: boolean;
  score: number | null;
}

export const getNpsInvite = (token: string) => apiFetch<NpsInvite>(`/nps/${encodeURIComponent(token)}`);
export const answerNps = (token: string, input: { score: number; comment?: string | null }) =>
  apiFetch<{ ok: true }>(`/nps/${encodeURIComponent(token)}`, { method: 'POST', body: input });
