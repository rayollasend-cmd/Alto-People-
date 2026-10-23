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
  /** The panel — everyone doing this interview (up to 3). */
  interviewers: { userId: string; email: string; name: string }[];
  scheduledFor: string;
  durationMinutes: number;
  location: string | null;
  completedAt: string | null;
  rating: number | null;
  scorecard: unknown;
}

/** Someone who can sit on an interview panel: staff with hiring permissions,
 *  plus the posting client's portal users when a candidate is named. */
export interface Interviewer {
  id: string;
  email: string;
  name: string;
  role: string;
  clientName: string | null;
}

export const listInterviewers = (candidateId?: string) =>
  apiFetch<{ interviewers: Interviewer[] }>(
    candidateId ? `/recruiting/interviewers?candidateId=${candidateId}` : '/recruiting/interviewers',
  );

/** Who a calendar invite went to. */
export interface InviteResult {
  candidate: boolean;
  interviewer: boolean;
}

export const listInterviews = (
  candidateId?: string,
  filters: { interviewerUserId?: string; from?: string; to?: string } = {},
) => {
  const p = new URLSearchParams();
  if (candidateId) p.set('candidateId', candidateId);
  if (filters.interviewerUserId) p.set('interviewerUserId', filters.interviewerUserId);
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  const qs = p.toString();
  return apiFetch<{ interviews: InterviewRecord[] }>(qs ? `/interviews?${qs}` : '/interviews');
};

export const createInterview = (input: {
  candidateId: string;
  kitId?: string | null;
  interviewerUserId?: string | null;
  /** The panel (up to 3). When given, interviewerUserId is its first member. */
  interviewerUserIds?: string[];
  scheduledFor: string;
  durationMinutes?: number;
  location?: string | null;
  /** Email the calendar invite (default: yes). */
  notify?: boolean;
}) => apiFetch<{ id: string; invited: InviteResult }>('/interviews', { method: 'POST', body: input });

/** Reschedule: the invite in their calendars is replaced, not duplicated. */
export const updateInterview = (
  id: string,
  input: {
    scheduledFor?: string;
    durationMinutes?: number;
    location?: string | null;
    interviewerUserId?: string | null;
    interviewerUserIds?: string[];
    notify?: boolean;
  },
) => apiFetch<{ ok: true; invited: InviteResult }>(`/interviews/${id}`, { method: 'PATCH', body: input });

export const scoreInterview = (
  id: string,
  input: { scorecard?: unknown; rating?: number | null },
) => apiFetch<{ ok: true }>(`/interviews/${id}/score`, { method: 'POST', body: input });

export const deleteInterview = (id: string) =>
  apiFetch<void>(`/interviews/${id}`, { method: 'DELETE' });

// ----- Offers ------------------------------------------------------------

export type OfferStatus =
  /** Pay outside the client's band — waiting on someone else's approval. */
  | 'PENDING_APPROVAL'
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
  createdById: string | null;
  /** Why it needed approval: the band it fell outside. */
  approvalNote: string | null;
  approvedByEmail: string | null;
  approvedAt: string | null;
  approvalDeclinedReason: string | null;
  /** The candidate's typed signature, when they accepted through their link. */
  signedName: string | null;
  signedAt: string | null;
  hasSignedPdf: boolean;
  declineReason: string | null;
}

// candidateId mirrors listInterviews — the server has always supported the
// filter; without it the candidate drawer would pull all 200 offers to show
// the two that belong to the person on screen.
export const listOffers = (candidateId?: string) =>
  apiFetch<{ offers: OfferRecord[] }>(
    candidateId ? `/offers?candidateId=${candidateId}` : '/offers',
  );

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
}) =>
  apiFetch<{ id: string; status: OfferStatus; approvalNote: string | null }>('/offers', {
    method: 'POST',
    body: input,
  });

/** Approve an offer held for its pay — not one you drafted. */
export const approveOffer = (id: string) =>
  apiFetch<{ ok: true }>(`/offers/${id}/approve`, { method: 'POST', body: {} });

export const declineOfferApproval = (id: string, reason: string) =>
  apiFetch<{ ok: true }>(`/offers/${id}/decline-approval`, { method: 'POST', body: { reason } });

/** Published offer-letter templates: the client's own, then global ones. */
export const listOfferLetterTemplates = (clientId?: string) =>
  apiFetch<{ templates: Array<{ id: string; name: string; clientName: string | null }> }>(
    `/offers/letter-templates${clientId ? `?clientId=${clientId}` : ''}`,
  );

/** The letter written from a template, ready to edit before saving. */
export const previewOfferLetter = (input: {
  candidateId: string;
  clientId: string;
  jobTitle: string;
  startDate: string;
  salary?: number | null;
  hourlyRate?: number | null;
  templateId?: string;
}) =>
  apiFetch<{ templateId: string; templateName: string; body: string; unresolvedTokens: string[] }>(
    '/offers/letter-preview',
    { method: 'POST', body: input },
  );

/** The signed letter, for opening in a new tab. */
export const signedOfferUrl = (id: string) => `/api/offers/${id}/signed.pdf`;

/**
 * Flip a DRAFT offer to SENT and email the candidate their signing link.
 * `emailed: false` means no candidate email was on file — the UI should
 * say so. `link` comes back only where email isn't configured (dev).
 */
export const sendOffer = (id: string) =>
  apiFetch<{ ok: true; emailed: boolean; link?: string }>(`/offers/${id}/send`, {
    method: 'POST',
    body: {},
  });

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

/**
 * Promote a referral into the candidate funnel. Creates (or links an
 * existing) Candidate with source 'referral' and returns its id.
 */
export const convertReferral = (id: string) =>
  apiFetch<{ candidateId: string }>(`/referrals/${id}/convert`, {
    method: 'POST',
    body: {},
  });

// ----- Job Postings ------------------------------------------------------

export type JobPostingStatus = 'DRAFT' | 'OPEN' | 'CLOSED';

export type JobPostingSchedule = 'FULL_TIME' | 'PART_TIME' | 'TEMPORARY' | 'SEASONAL';

export const SCHEDULE_LABEL: Record<JobPostingSchedule, string> = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  TEMPORARY: 'Temporary',
  SEASONAL: 'Seasonal',
};

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
  /** How many people the client asked for. */
  openings: number;
  /** Hired against this posting so far. */
  hired: number;
  schedule: JobPostingSchedule | null;
  payUnit: 'HOUR' | 'YEAR' | null;
  /** In the job-board feeds while open. */
  syndicate: boolean;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export const listJobPostings = () =>
  apiFetch<{ postings: JobPostingRecord[] }>('/job-postings');

/** What a posting for this client pays, from its rate cards in force today (pay rates only). */
export interface RateCardPay {
  clientId: string;
  clientName: string;
  rates: Array<{ position: string; payRate: number; effectiveFrom: string }>;
  suggested: { minPay: number; maxPay: number; payUnit: 'HOUR'; position: string | null } | null;
}
export const payFromRateCard = (clientId: string, position?: string) => {
  const q = new URLSearchParams({ clientId });
  if (position) q.set('position', position);
  return apiFetch<RateCardPay>(`/job-postings/pay-from-rate-card?${q.toString()}`);
};

export const createJobPosting = (input: {
  clientId?: string | null;
  title: string;
  description: string;
  location?: string | null;
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string;
  openings?: number;
  schedule?: JobPostingSchedule | null;
  payUnit?: 'HOUR' | 'YEAR' | null;
  syndicate?: boolean;
  slug: string;
}) => apiFetch<{ id: string }>('/job-postings', { method: 'POST', body: input });

/** What changes after a posting is up: the headcount, and whether job boards carry it. */
export const updateJobPosting = (
  id: string,
  body: { openings?: number; syndicate?: boolean; schedule?: JobPostingSchedule | null; payUnit?: 'HOUR' | 'YEAR' | null },
) => apiFetch<{ ok: true }>(`/job-postings/${id}`, { method: 'PATCH', body });

export const setJobPostingOpenings = (id: string, openings: number) => updateJobPosting(id, { openings });

/** The public job-board feed for one board; its links credit applicants to it. */
export const jobFeedUrl = (board: string) =>
  `${window.location.origin}/api/careers/feed.xml?board=${encodeURIComponent(board)}`;

export const openJobPosting = (id: string) =>
  apiFetch<{ ok: true }>(`/job-postings/${id}/open`, { method: 'POST', body: {} });

export const closeJobPosting = (id: string) =>
  apiFetch<{ ok: true }>(`/job-postings/${id}/close`, { method: 'POST', body: {} });

export const deleteJobPosting = (id: string) =>
  apiFetch<void>(`/job-postings/${id}`, { method: 'DELETE' });

// ----- The candidate's offer link (public) -------------------------------

export interface PublicOfferLetter {
  candidateFirstName: string;
  candidateName: string;
  jobTitle: string;
  clientName: string;
  startDate: string;
  pay: string;
  letterBody: string | null;
  status: OfferStatus;
  expiresAt: string | null;
  signedName: string | null;
  signedAt: string | null;
  /** Who sent it — named on every state of the page (F500 G5). Absent from an older server. */
  recruiter?: { name: string | null; email: string; phone: string | null } | null;
}

/** A copy of the letter to keep before deciding (on letterhead, unsigned). */
export const offerLetterPdfHref = (token: string) => `/api/offer-letters/${encodeURIComponent(token)}/letter.pdf`;

export const getOfferLetter = (token: string) =>
  apiFetch<PublicOfferLetter>(`/offer-letters/${encodeURIComponent(token)}`);

export const acceptOfferLetter = (token: string, typedName: string) =>
  apiFetch<{ ok: true; signedAt: string }>(`/offer-letters/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    body: { typedName, agree: true },
  });

export const declineOfferLetter = (token: string, reason: string | null) =>
  apiFetch<{ ok: true }>(`/offer-letters/${encodeURIComponent(token)}/decline`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
