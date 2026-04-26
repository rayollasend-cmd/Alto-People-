import type {
  Candidate,
  CandidateAdvanceInput,
  CandidateCreateInput,
  CandidateHireInput,
  CandidateListResponse,
  CandidateStage,
  CandidateUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listCandidates(filters: { stage?: CandidateStage } = {}): Promise<CandidateListResponse> {
  const qs = filters.stage ? `?stage=${filters.stage}` : '';
  return apiFetch<CandidateListResponse>(`/recruiting/candidates${qs}`);
}

export function getCandidate(id: string): Promise<Candidate> {
  return apiFetch<Candidate>(`/recruiting/candidates/${id}`);
}

export function createCandidate(body: CandidateCreateInput): Promise<Candidate> {
  return apiFetch<Candidate>('/recruiting/candidates', { method: 'POST', body });
}

export function updateCandidate(id: string, body: CandidateUpdateInput): Promise<Candidate> {
  return apiFetch<Candidate>(`/recruiting/candidates/${id}`, { method: 'PATCH', body });
}

export function advanceCandidate(id: string, body: CandidateAdvanceInput): Promise<Candidate> {
  return apiFetch<Candidate>(`/recruiting/candidates/${id}/advance`, {
    method: 'POST',
    body,
  });
}

export function hireCandidate(
  id: string,
  body: CandidateHireInput = {}
): Promise<Candidate & { applicationId: string | null }> {
  return apiFetch<Candidate & { applicationId: string | null }>(
    `/recruiting/candidates/${id}/hire`,
    { method: 'POST', body }
  );
}
