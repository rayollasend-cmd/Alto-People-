import type {
  BackgroundCheck,
  BackgroundCheckListResponse,
  BackgroundInitiateInput,
  BackgroundUpdateInput,
  EVerifyCaseDetail,
  EVerifyCaseInput,
  EVerifyIdentityInput,
  EVerifyRosterResponse,
  I9ListResponse,
  I9UpsertInput,
  I9Verification,
  J1ListResponse,
  J1Profile,
  J1UpsertInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listI9s(filter: 'pending' | 'complete' | 'all' = 'all'): Promise<I9ListResponse> {
  const qs = filter === 'all' ? '' : `?status=${filter}`;
  return apiFetch<I9ListResponse>(`/compliance/i9${qs}`);
}

export function upsertI9(associateId: string, body: I9UpsertInput): Promise<I9Verification> {
  return apiFetch<I9Verification>(`/compliance/i9/${associateId}`, {
    method: 'POST',
    body,
  });
}

/* ----- E-Verify directorate --------------------------------------------- */

/** Everyone onboarded or onboarding, with E-Verify state and what's blocking. */
export function listEVerifyRoster(): Promise<EVerifyRosterResponse> {
  return apiFetch<EVerifyRosterResponse>('/compliance/everify');
}

/**
 * Everything the federal portal asks for, in its field order. Carries a full
 * SSN, so it needs manage:compliance and every read is audited — fetch it when
 * a case is actually being worked, not to populate a list.
 */
export function getEVerifyCase(associateId: string): Promise<EVerifyCaseDetail> {
  return apiFetch<EVerifyCaseDetail>(`/compliance/everify/${associateId}`);
}

/** Record the case number and outcome HR got back from the portal. */
export function recordEVerifyCase(
  associateId: string,
  body: EVerifyCaseInput,
): Promise<{
  caseNumber: string | null;
  status: EVerifyCaseDetail['status'];
  caseOpenedAt: string | null;
  closedAt: string | null;
}> {
  return apiFetch(`/compliance/everify/${associateId}/case`, {
    method: 'POST',
    body,
  });
}

/** Middle initial / other last names only — see the route for why it's narrow. */
export function updateEVerifyIdentity(
  associateId: string,
  body: EVerifyIdentityInput,
): Promise<{ middleInitial: string | null; otherLastNames: string[] }> {
  return apiFetch(`/compliance/everify/${associateId}/identity`, {
    method: 'PATCH',
    body,
  });
}

export function listBackgroundChecks(): Promise<BackgroundCheckListResponse> {
  return apiFetch<BackgroundCheckListResponse>('/compliance/background');
}

export function initiateBackgroundCheck(
  body: BackgroundInitiateInput
): Promise<BackgroundCheck> {
  return apiFetch<BackgroundCheck>('/compliance/background', { method: 'POST', body });
}

export function updateBackgroundCheck(
  id: string,
  body: BackgroundUpdateInput
): Promise<BackgroundCheck> {
  return apiFetch<BackgroundCheck>(`/compliance/background/${id}/update`, {
    method: 'POST',
    body,
  });
}

export function listJ1Profiles(opts: { expiringWithin?: number } = {}): Promise<J1ListResponse> {
  const qs = opts.expiringWithin ? `?expiringWithin=${opts.expiringWithin}` : '';
  return apiFetch<J1ListResponse>(`/compliance/j1${qs}`);
}

export function upsertJ1(associateId: string, body: J1UpsertInput): Promise<J1Profile> {
  return apiFetch<J1Profile>(`/compliance/j1/${associateId}`, { method: 'POST', body });
}
