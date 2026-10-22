import type {
  AdverseActionListResponse,
  EeoApplicantReport,
  BackgroundBulkInitiateInput,
  BackgroundBulkInitiateResponse,
  BackgroundCheck,
  BackgroundCheckDetail,
  BackgroundCheckListResponse,
  BackgroundInitiateInput,
  BackgroundPendingResponse,
  BackgroundUpdateInput,
  DrugTest,
  DrugTestBulkInitiateInput,
  DrugTestBulkInitiateResponse,
  DrugTestDetail,
  DrugTestInitiateInput,
  DrugTestListResponse,
  DrugTestPendingResponse,
  DrugTestUpdateInput,
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

/** Check + report documents for the drawer. Every read is an audited
 *  disclosure (FCRA consumer report), so fetch on drawer open, not per row. */
export function getBackgroundCheckDetail(id: string): Promise<BackgroundCheckDetail> {
  return apiFetch<BackgroundCheckDetail>(`/compliance/background/${id}`);
}

/** Never-screened associates, shaped for the provider's bulk-order CSV. */
export function listPendingBackgroundChecks(): Promise<BackgroundPendingResponse> {
  return apiFetch<BackgroundPendingResponse>('/compliance/background/pending');
}

/** Call AFTER the CSV upload to the provider succeeds — never on download. */
export function bulkInitiateBackgroundChecks(
  body: BackgroundBulkInitiateInput,
): Promise<BackgroundBulkInitiateResponse> {
  return apiFetch<BackgroundBulkInitiateResponse>('/compliance/background/bulk-initiate', {
    method: 'POST',
    body,
  });
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

/* ----- FCRA adverse action (audit 2026-10-21 #14) ----------------------- */

/** The worklist: final notices due, reports to decide, notices waiting out their period, recent ones. */
export function listAdverseActions(): Promise<AdverseActionListResponse> {
  return apiFetch<AdverseActionListResponse>('/compliance/adverse-actions');
}

/** Pre-adverse notice with the report on file attached; starts the waiting period. */
export function sendPreAdverse(id: string, waitDays?: number): Promise<BackgroundCheck> {
  return apiFetch<BackgroundCheck>(`/compliance/background/${id}/pre-adverse`, {
    method: 'POST',
    body: waitDays ? { waitDays } : {},
  });
}

/** The final adverse action notice — only after the waiting period. */
export function sendFinalAdverse(id: string): Promise<BackgroundCheck> {
  return apiFetch<BackgroundCheck>(`/compliance/background/${id}/final-adverse`, { method: 'POST', body: {} });
}

/** The person answered: withdraw the pending adverse action and clear the check. */
export function withdrawAdverse(id: string): Promise<BackgroundCheck> {
  return apiFetch<BackgroundCheck>(`/compliance/background/${id}/withdraw-adverse`, { method: 'POST', body: {} });
}

/* ----- Applicant EEO self-identification (aggregate only) --------------- */

export function getEeoApplicantReport(range: { from?: string; to?: string } = {}): Promise<EeoApplicantReport> {
  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const q = qs.toString();
  return apiFetch<EeoApplicantReport>(`/compliance/eeo/applicant-report${q ? `?${q}` : ''}`);
}

/* ----- Drug tests -------------------------------------------------------- */

export function listDrugTests(): Promise<DrugTestListResponse> {
  return apiFetch<DrugTestListResponse>('/compliance/drug-tests');
}

/** Test + result documents for the drawer. Every read is an audited
 *  disclosure, so fetch on drawer open, not per row. */
export function getDrugTestDetail(id: string): Promise<DrugTestDetail> {
  return apiFetch<DrugTestDetail>(`/compliance/drug-tests/${id}`);
}

export function initiateDrugTest(body: DrugTestInitiateInput): Promise<DrugTest> {
  return apiFetch<DrugTest>('/compliance/drug-tests', { method: 'POST', body });
}

export function updateDrugTest(id: string, body: DrugTestUpdateInput): Promise<DrugTest> {
  return apiFetch<DrugTest>(`/compliance/drug-tests/${id}/update`, {
    method: 'POST',
    body,
  });
}

/** Everyone needing a test: no result inside the 60-day window, no order
 *  already in flight. Shaped for the provider's bulk-order CSV. */
export function listPendingDrugTests(): Promise<DrugTestPendingResponse> {
  return apiFetch<DrugTestPendingResponse>('/compliance/drug-tests/pending');
}

/** Call AFTER the CSV upload to the provider succeeds — never on download. */
export function bulkInitiateDrugTests(
  body: DrugTestBulkInitiateInput,
): Promise<DrugTestBulkInitiateResponse> {
  return apiFetch<DrugTestBulkInitiateResponse>('/compliance/drug-tests/bulk-initiate', {
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
