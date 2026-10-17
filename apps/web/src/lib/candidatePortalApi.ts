import { apiFetch } from './api';

/**
 * The candidate's own page (public, by signed link) and the recruiter's
 * side of it: the link, document requests, their review, and the
 * recruiter's calendar feed URL.
 */

export type DocumentRequestStatus = 'REQUESTED' | 'UPLOADED' | 'ACCEPTED' | 'REJECTED';

export interface DocumentRequest {
  id: string;
  candidateId: string;
  label: string;
  note: string | null;
  status: DocumentRequestStatus;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface PortalLinkResult {
  ok: true;
  emailed: boolean;
  texted: boolean;
  expiresAt: string;
  /** Present only when email isn't configured, so the recruiter can send it themselves. */
  link?: string;
}

export const sendCandidatePortalLink = (candidateId: string) =>
  apiFetch<PortalLinkResult>(`/recruiting/candidates/${candidateId}/portal-link`, { method: 'POST' });

export const listDocumentRequests = (candidateId: string) =>
  apiFetch<{ portal: { linkActive: boolean; expiresAt: string | null }; requests: DocumentRequest[] }>(
    `/recruiting/candidates/${candidateId}/document-requests`,
  );

export const createDocumentRequest = (candidateId: string, input: { label: string; note?: string | null; notify?: boolean }) =>
  apiFetch<{ request: DocumentRequest; emailed: boolean; texted: boolean; link?: string }>(
    `/recruiting/candidates/${candidateId}/document-requests`,
    { method: 'POST', body: input },
  );

export const reviewDocumentRequest = (id: string, input: { decision: 'ACCEPT' | 'REJECT'; note?: string | null }) =>
  apiFetch<{ request: DocumentRequest }>(`/recruiting/document-requests/${id}/review`, { method: 'POST', body: input });

export const documentRequestFileUrl = (id: string) => `/api/recruiting/document-requests/${id}/file`;

export const getRecruiterCalendarUrl = () => apiFetch<{ url: string; webcalUrl: string }>('/recruiting/me/calendar-url');
export const rotateRecruiterCalendarUrl = () =>
  apiFetch<{ url: string; webcalUrl: string }>('/recruiting/me/calendar-url/rotate', { method: 'POST' });

/* ===== The candidate's page (no login) ===================================== */

export interface CandidatePortal {
  orgName: string;
  firstName: string;
  position: string | null;
  postingSlug: string | null;
  stage: string;
  stageLabel: string;
  stageDetail: string;
  expiresAt: string;
  interviews: Array<{
    id: string;
    scheduledFor: string;
    when: string;
    durationMinutes: number;
    location: string | null;
    interviewerName: string | null;
    confirmedAt: string | null;
  }>;
  documents: Array<{
    id: string;
    label: string;
    note: string | null;
    status: DocumentRequestStatus;
    fileName: string | null;
    uploadedAt: string | null;
    reviewNote: string | null;
  }>;
}

export const getCandidatePortal = (token: string) => apiFetch<CandidatePortal>(`/candidate-portal/${encodeURIComponent(token)}`);

export const confirmPortalInterview = (token: string, interviewId: string) =>
  apiFetch<{ ok: true; confirmedAt: string }>(`/candidate-portal/${encodeURIComponent(token)}/interviews/${interviewId}/confirm`, { method: 'POST' });

/** Multipart, so not apiFetch (which JSON-encodes bodies). */
export async function uploadPortalDocument(token: string, requestId: string, file: File): Promise<{ ok: true; status: DocumentRequestStatus; fileName: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/candidate-portal/${encodeURIComponent(token)}/documents/${requestId}`, { method: 'POST', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return (await res.json()) as { ok: true; status: DocumentRequestStatus; fileName: string };
}
