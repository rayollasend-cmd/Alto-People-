import type {
  Candidate,
  CandidateAdvanceInput,
  CandidateBoardResponse,
  CandidateCreateInput,
  CandidateFilters,
  CandidateEventListResponse,
  CandidateHireInput,
  CandidateHireResponse,
  CandidateListResponse,
  CandidateStage,
  CandidateUpdateInput,
  RecruitingAnalytics,
  RecruitingSourceSpend,
  RecruitingSourceSpendInput,
  RecruitingSummary,
} from '@alto-people/shared';
import { apiFetch } from './api';

/** The filters as query params — empty ones left out, so URLs stay short. */
function filterParams(filters: CandidateFilters, extra: Record<string, string | number | undefined> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filters, ...extra })) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/**
 * A page of candidates, filtered and sorted on the server, with the total
 * that match. `limit` defaults to 50 (the server caps it at 200).
 */
export function listCandidates(
  filters: CandidateFilters & { stage?: CandidateStage | string } = {},
  page: { limit?: number; offset?: number } = {},
): Promise<CandidateListResponse> {
  return apiFetch<CandidateListResponse>(`/recruiting/candidates${filterParams(filters, page)}`);
}

/** The board: every stage's count, and the first `perStage` of each column. */
export function getCandidateBoard(filters: CandidateFilters = {}, perStage = 25): Promise<CandidateBoardResponse> {
  const { stage: _stage, ...rest } = filters;
  return apiFetch<CandidateBoardResponse>(`/recruiting/candidates/board${filterParams(rest, { perStage })}`);
}

/** Every candidate matching the filters, a page at a time — for CSV export. */
export async function listAllCandidates(filters: CandidateFilters, max = 5000): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let offset = 0; offset < max; offset += 200) {
    const page = await listCandidates(filters, { limit: 200, offset });
    out.push(...page.candidates);
    if (out.length >= page.total || page.candidates.length === 0) break;
  }
  return out;
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

/* ----- Client review ------------------------------------------------------ */

export type SubmittalStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN';

/** A candidate put in front of a client, and the client's answer. */
export interface CandidateSubmittal {
  id: string;
  clientId: string;
  clientName: string;
  locationName: string | null;
  pitch: string | null;
  status: SubmittalStatus;
  feedback: string | null;
  submittedByEmail: string | null;
  decidedByEmail: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export function listSubmittals(candidateId: string): Promise<{ submittals: CandidateSubmittal[] }> {
  return apiFetch<{ submittals: CandidateSubmittal[] }>(`/recruiting/candidates/${candidateId}/submittals`);
}

export function submitToClient(
  candidateId: string,
  body: { clientId: string; locationId?: string; pitch?: string },
): Promise<CandidateSubmittal> {
  return apiFetch<CandidateSubmittal>(`/recruiting/candidates/${candidateId}/submittals`, { method: 'POST', body });
}

export function withdrawSubmittal(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/recruiting/submittals/${id}/withdraw`, { method: 'POST' });
}

/* ----- Analytics ---------------------------------------------------------- */

/** The recruiting dashboard for a range of days (both inclusive, YYYY-MM-DD). */
export function getRecruitingAnalytics(range: { from: string; to: string }): Promise<RecruitingAnalytics> {
  const qs = new URLSearchParams(range).toString();
  return apiFetch<RecruitingAnalytics>(`/recruiting/analytics?${qs}`);
}

export function listSourceSpend(): Promise<{ spend: RecruitingSourceSpend[] }> {
  return apiFetch<{ spend: RecruitingSourceSpend[] }>('/recruiting/source-spend');
}

/** One amount per source per month; saving a month again replaces it. */
export function saveSourceSpend(body: RecruitingSourceSpendInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>('/recruiting/source-spend', { method: 'PUT', body });
}

export function deleteSourceSpend(id: string): Promise<void> {
  return apiFetch<void>(`/recruiting/source-spend/${id}`, { method: 'DELETE' });
}
