import type {
  AdverseActionListResponse,
  EeoApplicantReport,
  BackgroundBulkInitiateInput,
  BackgroundBulkInitiateResponse,
  BackgroundCheck,
  BackgroundCheckDetail,
  BackgroundCheckListResponse,
  BackgroundPendingResponse,
  BackgroundUpdateInput,
  DrugTest,
  DrugTestBulkInitiateInput,
  DrugTestBulkInitiateResponse,
  DrugTestDetail,
  DrugTestListResponse,
  DrugTestPendingResponse,
  DrugTestUpdateInput,
  EVerifyCaseDetail,
  EVerifyCaseInput,
  EVerifyIdentityInput,
  EVerifyRosterResponse,
  I9DestroyResponse,
  I9ListResponse,
  I9Reverification,
  I9ReverificationInput,
  I9ReverificationListResponse,
  I9UpsertInput,
  I9Verification,
  J1ListResponse,
  J1Profile,
  J1UpsertInput,
} from '@alto-people/shared';
import type { ComplianceWorkforce } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * `?workforce=` on a compliance list (owner, 2026-11-03): who the list is
 * about. Left out, the server opens on the current workforce.
 */
function withWorkforce(path: string, workforce: ComplianceWorkforce | undefined): string {
  if (!workforce) return path;
  return `${path}${path.includes('?') ? '&' : '?'}workforce=${workforce}`;
}

export function listI9s(filter: 'pending' | 'complete' | 'all' = 'all', opts: { workforce?: ComplianceWorkforce } = {}): Promise<I9ListResponse> {
  const qs = filter === 'all' ? '' : `?status=${filter}`;
  return apiFetch<I9ListResponse>(withWorkforce(`/compliance/i9${qs}`, opts.workforce));
}

export function upsertI9(associateId: string, body: I9UpsertInput): Promise<I9Verification> {
  return apiFetch<I9Verification>(`/compliance/i9/${associateId}`, {
    method: 'POST',
    body,
  });
}

/** One person's re-verifications (Supplement B), newest first. */
export function listI9Reverifications(associateId: string): Promise<I9ReverificationListResponse> {
  return apiFetch<I9ReverificationListResponse>(`/compliance/i9/${associateId}/reverifications`);
}

/** Record a Supplement B entry: a re-verification (document, new end) or a rehire reusing the I-9. */
export function recordI9Reverification(associateId: string, body: I9ReverificationInput): Promise<I9Reverification> {
  return apiFetch<I9Reverification>(`/compliance/i9/${associateId}/reverification`, {
    method: 'POST',
    body,
  });
}

/** Destroy one I-9 past retention; `confirm` is the typed word DESTROY. Permanent. */
export function destroyI9(associateId: string, confirm: string): Promise<I9DestroyResponse> {
  return apiFetch<I9DestroyResponse>(`/compliance/i9/${associateId}/destroy`, { method: 'POST', body: { confirm } });
}

/** Destroy several I-9s past retention; `confirm` is the typed count. Each is checked again on the server. */
export function destroyI9s(associateIds: string[], confirm: string): Promise<I9DestroyResponse> {
  return apiFetch<I9DestroyResponse>('/compliance/i9/destroy', { method: 'POST', body: { associateIds, confirm } });
}

/* ----- E-Verify directorate --------------------------------------------- */

/** Everyone onboarded or onboarding, with E-Verify state and what's blocking. */
export function listEVerifyRoster(opts: { workforce?: ComplianceWorkforce } = {}): Promise<EVerifyRosterResponse> {
  return apiFetch<EVerifyRosterResponse>(withWorkforce('/compliance/everify', opts.workforce));
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

export function listBackgroundChecks(opts: { workforce?: ComplianceWorkforce } = {}): Promise<BackgroundCheckListResponse> {
  return apiFetch<BackgroundCheckListResponse>(withWorkforce('/compliance/background', opts.workforce));
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

/** The worklist: final notices due, reports to decide, notices waiting out their period, recent ones —
 *  for one group of people, or several at once (the Inbox's Current + Starting soon; this list
 *  alone takes a comma list). Left out, the server opens on the current workforce. */
export function listAdverseActions(opts: { workforce?: ComplianceWorkforce | readonly ComplianceWorkforce[] } = {}): Promise<AdverseActionListResponse> {
  const w = opts.workforce;
  const param = typeof w === 'string' ? w : w && w.length > 0 ? w.join(',') : null;
  return apiFetch<AdverseActionListResponse>(param ? `/compliance/adverse-actions?workforce=${param}` : '/compliance/adverse-actions');
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

export function listDrugTests(opts: { workforce?: ComplianceWorkforce } = {}): Promise<DrugTestListResponse> {
  return apiFetch<DrugTestListResponse>(withWorkforce('/compliance/drug-tests', opts.workforce));
}

/** Test + result documents for the drawer. Every read is an audited
 *  disclosure, so fetch on drawer open, not per row. */
export function getDrugTestDetail(id: string): Promise<DrugTestDetail> {
  return apiFetch<DrugTestDetail>(`/compliance/drug-tests/${id}`);
}

export function updateDrugTest(id: string, body: DrugTestUpdateInput): Promise<DrugTest> {
  return apiFetch<DrugTest>(`/compliance/drug-tests/${id}/update`, {
    method: 'POST',
    body,
  });
}

/* A drug test through a consumer reporting agency takes the FCRA steps (2026-11-03). */

/** Pre-adverse notice with the result on file attached; starts the waiting period. */
export function sendDrugPreAdverse(id: string, waitDays?: number): Promise<DrugTest> {
  return apiFetch<DrugTest>(`/compliance/drug-tests/${id}/pre-adverse`, {
    method: 'POST',
    body: waitDays ? { waitDays } : {},
  });
}

/** The final adverse action notice — only after the waiting period. Records the test as failed. */
export function sendDrugFinalAdverse(id: string): Promise<DrugTest> {
  return apiFetch<DrugTest>(`/compliance/drug-tests/${id}/final-adverse`, { method: 'POST', body: {} });
}

/** The person answered: withdraw the pending adverse action and clear the test. */
export function withdrawDrugAdverse(id: string): Promise<DrugTest> {
  return apiFetch<DrugTest>(`/compliance/drug-tests/${id}/withdraw-adverse`, { method: 'POST', body: {} });
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

export function listJ1Profiles(opts: { expiringWithin?: number; workforce?: ComplianceWorkforce } = {}): Promise<J1ListResponse> {
  const qs = opts.expiringWithin ? `?expiringWithin=${opts.expiringWithin}` : '';
  return apiFetch<J1ListResponse>(withWorkforce(`/compliance/j1${qs}`, opts.workforce));
}

export function upsertJ1(associateId: string, body: J1UpsertInput): Promise<J1Profile> {
  return apiFetch<J1Profile>(`/compliance/j1/${associateId}`, { method: 'POST', body });
}
