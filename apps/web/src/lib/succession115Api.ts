import { apiFetch } from './api';

export type SuccessionReadiness =
  | 'READY_NOW'
  | 'READY_1_2_YEARS'
  | 'READY_3_PLUS_YEARS'
  | 'EMERGENCY_COVER';

export interface SuccessionPositionRow {
  id: string;
  code: string;
  title: string;
  status: string;
  clientId: string;
  clientName: string | null;
  departmentName: string | null;
  incumbent: { id: string; name: string } | null;
  successorCount: number;
}

export interface SuccessionCandidateRow {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  currentTitle: string | null;
  readiness: SuccessionReadiness;
  notes: string | null;
  createdAt: string;
}

export interface SuccessionPositionDetail {
  position: {
    id: string;
    title: string;
    code: string;
    clientName: string | null;
    incumbent: { id: string; name: string } | null;
  };
  candidates: SuccessionCandidateRow[];
}

export interface SuccessionSummary {
  positionCount: number;
  positionsWithSuccessor: number;
  coverage: number;
  byReadiness: Record<SuccessionReadiness, number>;
}

export const listSuccessionPositions = (clientId?: string) =>
  apiFetch<{ positions: SuccessionPositionRow[] }>(
    `/succession/positions${clientId ? `?clientId=${clientId}` : ''}`,
  );

export const getSuccessionPosition = (id: string) =>
  apiFetch<SuccessionPositionDetail>(`/succession/positions/${id}/candidates`);

export const getSuccessionSummary = () =>
  apiFetch<SuccessionSummary>('/succession/summary');

export const createSuccessionCandidate = (input: {
  positionId: string;
  associateId: string;
  readiness: SuccessionReadiness;
  notes?: string | null;
}) =>
  apiFetch<{ id: string }>('/succession/candidates', {
    method: 'POST',
    body: input,
  });

export const updateSuccessionCandidate = (
  id: string,
  input: Partial<{ readiness: SuccessionReadiness; notes: string | null }>,
) =>
  apiFetch<{ ok: true }>(`/succession/candidates/${id}`, {
    method: 'PATCH',
    body: input,
  });

export const deleteSuccessionCandidate = (id: string) =>
  apiFetch<void>(`/succession/candidates/${id}`, { method: 'DELETE' });

export const READINESS_LABELS: Record<SuccessionReadiness, string> = {
  READY_NOW: 'Ready now',
  READY_1_2_YEARS: 'Ready 1–2 years',
  READY_3_PLUS_YEARS: 'Ready 3+ years',
  EMERGENCY_COVER: 'Emergency cover',
};
