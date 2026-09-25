import type {
  Candidate,
  CandidateAdvanceInput,
  CandidateCreateInput,
  CandidateEventListResponse,
  CandidateHireInput,
  CandidateHireResponse,
  CandidateListResponse,
  CandidateStage,
  CandidateUpdateInput,
  RecruitingSummary,
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

/** Hire = invite to onboarding; client and template are required. */
export function hireCandidate(id: string, body: CandidateHireInput): Promise<CandidateHireResponse> {
  return apiFetch<CandidateHireResponse>(`/recruiting/candidates/${id}/hire`, {
    method: 'POST',
    body,
  });
}

/** The candidate's timeline, newest first. */
export function listCandidateEvents(id: string): Promise<CandidateEventListResponse> {
  return apiFetch<CandidateEventListResponse>(`/recruiting/candidates/${id}/events`);
}

export function addCandidateNote(id: string, body: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/recruiting/candidates/${id}/notes`, {
    method: 'POST',
    body: { body },
  });
}

/** The recruiter's dashboard: pipeline counts and what's waiting. */
export function getRecruitingSummary(): Promise<RecruitingSummary> {
  return apiFetch<RecruitingSummary>('/recruiting/summary');
}
