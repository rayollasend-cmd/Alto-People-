import { apiFetch } from './api';

// ----- Interview Kits ----------------------------------------------------

export type InterviewQuestionKind = 'BEHAVIORAL' | 'TECHNICAL' | 'CULTURAL' | 'GENERAL';

export interface InterviewQuestion {
  prompt: string;
  kind?: InterviewQuestionKind;
  hint?: string | null;
}

export interface InterviewKit {
  id: string;
  clientId: string | null;
  name: string;
  description: string | null;
  questions: InterviewQuestion[];
  updatedAt: string;
}

export const listInterviewKits = () =>
  apiFetch<{ kits: InterviewKit[] }>('/interview-kits');

export const createInterviewKit = (input: {
  clientId?: string | null;
  name: string;
  description?: string | null;
  questions?: InterviewQuestion[];
}) => apiFetch<{ id: string }>('/interview-kits', { method: 'POST', body: input });

export const updateInterviewKit = (
  id: string,
  input: {
    name?: string;
    description?: string | null;
    questions?: InterviewQuestion[];
  },
) => apiFetch<{ ok: true }>(`/interview-kits/${id}`, { method: 'PUT', body: input });

export const deleteInterviewKit = (id: string) =>
  apiFetch<void>(`/interview-kits/${id}`, { method: 'DELETE' });

// ----- Interviews --------------------------------------------------------

export interface InterviewRecord {
  id: string;
  candidateId: string;
  candidateName: string;
  kitId: string | null;
  kitName: string | null;
  interviewerUserId: string | null;
  interviewerEmail: string | null;
  scheduledFor: string;
  completedAt: string | null;
  rating: number | null;
  scorecard: unknown;
}

export const listInterviews = (candidateId?: string) =>
  apiFetch<{ interviews: InterviewRecord[] }>(
    candidateId ? `/interviews?candidateId=${candidateId}` : '/interviews',
  );

export const createInterview = (input: {
  candidateId: string;
  kitId?: string | null;
  interviewerUserId?: string | null;
  scheduledFor: string;
}) => apiFetch<{ id: string }>('/interviews', { method: 'POST', body: input });

export const scoreInterview = (
  id: string,
  input: { scorecard?: unknown; rating?: number | null },
) => apiFetch<{ ok: true }>(`/interviews/${id}/score`, { method: 'POST', body: input });

export const deleteInterview = (id: string) =>
  apiFetch<void>(`/interviews/${id}`, { method: 'DELETE' });

// ----- Offers ------------------------------------------------------------

export type OfferStatus =
  | 'DRAFT'
  | 'SENT'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'WITHDRAWN';

export interface OfferRecord {
  id: string;
  candidateId: string;
  candidateName: string;
  clientId: string;
  clientName: string;
  jobTitle: string;
  startDate: string;
  salary: string | null;
  hourlyRate: string | null;
  currency: string;
  letterBody: string | null;
  status: OfferStatus;
  sentAt: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export const listOffers = () =>
  apiFetch<{ offers: OfferRecord[] }>('/offers');

export const createOffer = (input: {
  candidateId: string;
  clientId: string;
  jobTitle: string;
  startDate: string;
  salary?: number | null;
  hourlyRate?: number | null;
  currency?: string;
  letterBody?: string | null;
  expiresAt?: string | null;
}) => apiFetch<{ id: string }>('/offers', { method: 'POST', body: input });

export const sendOffer = (id: string) =>
  apiFetch<{ ok: true }>(`/offers/${id}/send`, { method: 'POST', body: {} });

export const decideOffer = (
  id: string,
  decision: 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED',
) =>
  apiFetch<{ ok: true }>(`/offers/${id}/decision`, {
    method: 'POST',
    body: { decision },
  });

// ----- Referrals ---------------------------------------------------------

export type ReferralStatus = 'OPEN' | 'INTERVIEWING' | 'HIRED' | 'REJECTED';

export interface ReferralRecord {
  id: string;
  referrerUserId: string;
  referrerEmail: string;
  candidateId: string | null;
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string | null;
  position: string | null;
  notes: string | null;
  status: ReferralStatus;
  bonusAmount: string | null;
  bonusCurrency: string;
  bonusPaidAt: string | null;
  createdAt: string;
}

export const listReferrals = () =>
  apiFetch<{ referrals: ReferralRecord[] }>('/referrals');

export const createReferral = (input: {
  candidateName: string;
  candidateEmail: string;
  candidatePhone?: string | null;
  position?: string | null;
  notes?: string | null;
  bonusAmount?: number | null;
  bonusCurrency?: string;
}) => apiFetch<{ id: string }>('/referrals', { method: 'POST', body: input });

export const setReferralStatus = (id: string, status: ReferralStatus) =>
  apiFetch<{ ok: true }>(`/referrals/${id}/status`, {
    method: 'POST',
    body: { status },
  });

export const markReferralBonusPaid = (id: string) =>
  apiFetch<{ ok: true }>(`/referrals/${id}/bonus-paid`, {
    method: 'POST',
    body: {},
  });

// ----- Job Postings ------------------------------------------------------

export type JobPostingStatus = 'DRAFT' | 'OPEN' | 'CLOSED';

export interface JobPostingRecord {
  id: string;
  clientId: string | null;
  clientName: string | null;
  title: string;
  description: string;
  location: string | null;
  minSalary: string | null;
  maxSalary: string | null;
  currency: string;
  slug: string;
  status: JobPostingStatus;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export const listJobPostings = () =>
  apiFetch<{ postings: JobPostingRecord[] }>('/job-postings');

export const createJobPosting = (input: {
  clientId?: string | null;
  title: string;
  description: string;
  location?: string | null;
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string;
  slug: string;
}) => apiFetch<{ id: string }>('/job-postings', { method: 'POST', body: input });

export const openJobPosting = (id: string) =>
  apiFetch<{ ok: true }>(`/job-postings/${id}/open`, { method: 'POST', body: {} });

export const closeJobPosting = (id: string) =>
  apiFetch<{ ok: true }>(`/job-postings/${id}/close`, { method: 'POST', body: {} });

export const deleteJobPosting = (id: string) =>
  apiFetch<void>(`/job-postings/${id}`, { method: 'DELETE' });
