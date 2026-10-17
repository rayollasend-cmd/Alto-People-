import { apiFetch } from './api';

/** Employment and income verification letters (HR pack 2026-10). */

export type LetterKind = 'EMPLOYMENT' | 'INCOME';
export type LetterStatus = 'REQUESTED' | 'APPROVED' | 'DECLINED';

export interface VerificationLetter {
  id: string;
  associateId: string;
  associateName?: string;
  associateEmail?: string | null;
  kind: LetterKind;
  status: LetterStatus;
  addressedTo: string | null;
  purpose: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  createdAt: string;
}

export const requestLetter = (input: { kind: LetterKind; addressedTo?: string | null; purpose?: string | null }) =>
  apiFetch<{ id: string }>('/my/verification-letters', { method: 'POST', body: input });
export const listMyLetters = () => apiFetch<{ letters: VerificationLetter[] }>('/my/verification-letters');
export const listLetters = (status?: LetterStatus) =>
  apiFetch<{ letters: VerificationLetter[] }>(`/verification-letters${status ? `?status=${status}` : ''}`);
export const approveLetter = (id: string) => apiFetch<{ ok: true }>(`/verification-letters/${id}/approve`, { method: 'POST' });
export const declineLetter = (id: string, reason: string) =>
  apiFetch<{ ok: true }>(`/verification-letters/${id}/decline`, { method: 'POST', body: { reason } });
export const letterPdfUrl = (id: string) => `/api/verification-letters/${id}/pdf`;
