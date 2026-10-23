import { apiFetch } from './api';

export type ProbationStatus = 'ACTIVE' | 'PASSED' | 'EXTENDED' | 'FAILED';

export interface ProbationRow {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  currentTitle: string | null;
  startDate: string;
  endDate: string;
  status: ProbationStatus;
  decision: string | null;
  decidedAt: string | null;
  decidedByEmail: string | null;
}

export interface ProbationEndingSoonRow {
  id: string;
  associateId: string;
  associateName: string;
  currentTitle: string | null;
  managerName: string | null;
  endDate: string;
  daysUntil: number;
  overdue: boolean;
}

export interface ProbationSummary {
  active: number;
  endingSoon: number;
  overdue: number;
  passedLast90Days: number;
  failedLast90Days: number;
}

/** One page of probations: open ones soonest-ending first, decided ones newest first. */
/** The summary tiles' windows, as list filters. */
export type ProbationWindow = 'ending14' | 'overdue' | 'passed90' | 'failed90';

export const listProbations = (status?: ProbationStatus, page = 0, window?: ProbationWindow) => {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (window) qs.set('window', window);
  if (page) qs.set('page', String(page));
  const q = qs.toString();
  return apiFetch<{ probations: ProbationRow[]; total?: number; page?: number; hasMore?: boolean }>(`/probations${q ? `?${q}` : ''}`);
};

export const getProbationSummary = () =>
  apiFetch<ProbationSummary>('/probations/summary');

export const startProbation = (input: {
  associateId: string;
  startDate: string;
  endDate: string;
}) =>
  apiFetch<{ id: string }>('/probations', { method: 'POST', body: input });

export const decideProbation = (
  id: string,
  input: { decision: 'PASSED' | 'FAILED'; notes?: string | null },
) =>
  apiFetch<{ ok: true }>(`/probations/${id}/decide`, {
    method: 'POST',
    body: input,
  });

export const extendProbation = (
  id: string,
  input: { newEndDate: string; notes?: string | null },
) =>
  apiFetch<{ id: string }>(`/probations/${id}/extend`, {
    method: 'POST',
    body: input,
  });
