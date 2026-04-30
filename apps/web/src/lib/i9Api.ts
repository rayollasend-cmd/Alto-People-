import { ApiError, NetworkError } from './api';

export type CitizenshipStatus =
  | 'US_CITIZEN'
  | 'NON_CITIZEN_NATIONAL'
  | 'LAWFUL_PERMANENT_RESIDENT'
  | 'ALIEN_AUTHORIZED_TO_WORK';

export interface I9Status {
  associateId: string;
  section1: {
    completedAt: string;
    citizenshipStatus: CitizenshipStatus;
    workAuthExpiresAt: string | null;
    hasAlienNumber: boolean;
    typedName: string | null;
  } | null;
  documentsSubmittedAt: string | null;
  section2: {
    completedAt: string;
    verifierEmail: string | null;
    documentList: 'LIST_A' | 'LIST_B_AND_C' | null;
    supportingDocIds: string[];
  } | null;
}

export interface Section1Input {
  citizenshipStatus: CitizenshipStatus;
  typedName: string;
  alienRegistrationNumber?: string;
  workAuthExpiresAt?: string; // YYYY-MM-DD
}

export interface I9DocumentMeta {
  documentId: string;
  kind: string;
  side: 'FRONT' | 'BACK' | null;
  size: number;
  mimeType: string;
  sha256: string;
}

export interface Section2Input {
  documentList: 'LIST_A' | 'LIST_B_AND_C';
  supportingDocIds: string[];
}

export interface I9DocumentListItem {
  id: string;
  kind: 'I9_SUPPORTING' | 'ID' | 'SSN_CARD' | 'J1_VISA' | 'J1_DS2019';
  filename: string;
  mimeType: string;
  size: number;
  status: 'PENDING' | 'UPLOADED' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
  side: 'FRONT' | 'BACK' | null;
  createdAt: string;
}

export function listI9Documents(
  applicationId: string
): Promise<{ documents: I9DocumentListItem[] }> {
  return jsonFetch(`/api/onboarding/applications/${applicationId}/i9/documents`);
}

export function getI9Status(applicationId: string): Promise<I9Status> {
  return jsonFetch<I9Status>(`/api/onboarding/applications/${applicationId}/i9`);
}

export function submitI9Section1(
  applicationId: string,
  body: Section1Input
): Promise<{ section1CompletedAt: string; citizenshipStatus: CitizenshipStatus }> {
  return jsonFetch(`/api/onboarding/applications/${applicationId}/i9/section1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function uploadI9Document(
  applicationId: string,
  file: File,
  documentKind: 'I9_SUPPORTING' | 'ID' | 'SSN_CARD' | 'J1_VISA' | 'J1_DS2019',
  documentSide?: 'FRONT' | 'BACK'
): Promise<I9DocumentMeta> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('documentKind', documentKind);
  if (documentSide) fd.append('documentSide', documentSide);
  // Note: don't set Content-Type — the browser sets it with the multipart
  // boundary automatically.
  return jsonFetch(`/api/onboarding/applications/${applicationId}/i9/documents`, {
    method: 'POST',
    body: fd,
  });
}

export function submitI9ForReview(
  applicationId: string
): Promise<{ documentsSubmittedAt: string }> {
  return jsonFetch(`/api/onboarding/applications/${applicationId}/i9/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

export function submitI9Section2(
  applicationId: string,
  body: Section2Input
): Promise<{ section2CompletedAt: string; documentList: string; supportingDocIds: string[] }> {
  return jsonFetch(`/api/onboarding/applications/${applicationId}/i9/section2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Local fetch helper because the shared apiFetch always JSON-encodes the
// body. We need raw FormData support for the camera-upload path AND
// behavior-identical error handling everywhere else.
async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', ...init });
  } catch (err) {
    throw new NetworkError(err);
  }
  if (res.status === 204) return undefined as T;
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `http_${res.status}`,
      err?.message ?? `Request failed (${res.status})`
    );
  }
  return parsed as T;
}
