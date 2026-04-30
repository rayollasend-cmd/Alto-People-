import type {
  ApplicationCreateInput,
  ApplicationDetail,
  ApplicationListResponse,
  ApplicationPoliciesResponse,
  ApplicationStatsResponse,
  AuditLogListResponse,
  BackgroundCheck,
  BackgroundCheckAuthorizeInput,
  BulkInviteInput,
  BulkInviteResponse,
  BulkResendInput,
  BulkResendResponse,
  ClientListResponse,
  DirectDepositInput,
  DocumentUploadCompleteResponse,
  J1DocsCompleteResponse,
  J1Profile,
  J1UpsertInput,
  NudgeInput,
  NudgeResponse,
  OnboardingTemplate,
  PolicyAckInput,
  ProfileSubmission,
  TemplateListResponse,
  TemplateUpsertInput,
  W4SubmissionInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export interface ListApplicationsFilters {
  status?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export function listApplications(
  filters: ListApplicationsFilters = {}
): Promise<ApplicationListResponse> {
  const p = new URLSearchParams();
  if (filters.status && filters.status !== 'ALL') p.set('status', filters.status);
  if (filters.q && filters.q.trim()) p.set('q', filters.q.trim());
  if (filters.page && filters.page > 1) p.set('page', String(filters.page));
  if (filters.pageSize) p.set('pageSize', String(filters.pageSize));
  const qs = p.toString();
  return apiFetch<ApplicationListResponse>(
    `/onboarding/applications${qs ? `?${qs}` : ''}`
  );
}

// Aggregated stats for the Onboarding sidebar tiles. Replaces the prior
// pattern of fetching the entire (unfiltered) application list to count
// statuses client-side.
export function getApplicationStats(): Promise<ApplicationStatsResponse> {
  return apiFetch<ApplicationStatsResponse>('/onboarding/applications/stats');
}

export interface CreateApplicationResponse {
  id: string;
  invitedUserId: string;
  /**
   * Present only when the API isn't configured with Resend (dev mode):
   * the raw accept-invite link HR can copy/paste to the new associate.
   * In prod this is always null because the email goes out for real.
   */
  inviteUrl: string | null;
}

export function createApplication(
  body: ApplicationCreateInput
): Promise<CreateApplicationResponse> {
  return apiFetch<CreateApplicationResponse>('/onboarding/applications', {
    method: 'POST',
    body,
  });
}

export function resendInvite(applicationId: string): Promise<{
  invitedUserId: string;
  inviteUrl: string | null;
}> {
  return apiFetch<{ invitedUserId: string; inviteUrl: string | null }>(
    `/onboarding/applications/${applicationId}/resend-invite`,
    { method: 'POST' }
  );
}

/* ----------------- HR review outcome (approve / reject) --------------- */

export function approveApplication(
  applicationId: string,
  body: { hireDate: string }
): Promise<void> {
  return apiFetch<void>(
    `/onboarding/applications/${applicationId}/approve`,
    { method: 'POST', body }
  );
}

export function rejectApplication(
  applicationId: string,
  body: { reason: string }
): Promise<void> {
  return apiFetch<void>(
    `/onboarding/applications/${applicationId}/reject`,
    { method: 'POST', body }
  );
}

/* ---------------------- Phase 58 — bulk + nudge ----------------------- */

export function bulkInvite(body: BulkInviteInput): Promise<BulkInviteResponse> {
  return apiFetch<BulkInviteResponse>('/onboarding/applications/bulk', {
    method: 'POST',
    body,
  });
}

export function bulkResendInvite(body: BulkResendInput): Promise<BulkResendResponse> {
  return apiFetch<BulkResendResponse>('/onboarding/applications/bulk-resend', {
    method: 'POST',
    body,
  });
}

export function nudgeApplicant(
  applicationId: string,
  body: NudgeInput
): Promise<NudgeResponse> {
  return apiFetch<NudgeResponse>(
    `/onboarding/applications/${applicationId}/nudge`,
    { method: 'POST', body }
  );
}

/* ---------------------- Phase 59 — compliance packet --------------------- */

/**
 * URL of the per-application compliance packet PDF. Use as the `href` of
 * an anchor with `download=` so the browser handles streaming + Save As.
 * The cookie session is sent automatically because we're same-origin
 * (Vite dev proxy keeps `/api/*` on the same origin as the SPA).
 */
export function compliancePacketUrl(applicationId: string): string {
  return `/api/onboarding/applications/${applicationId}/packet.pdf`;
}

export function listClients(): Promise<ClientListResponse> {
  return apiFetch<ClientListResponse>('/clients');
}

/* ---------------------- Phase 19 / Phase 36 — e-sign --------------------- */

export interface EsignAgreement {
  id: string;
  applicationId: string;
  taskId: string | null;
  title: string;
  body: string;
  createdAt: string;
  signedAt: string | null;
  signatureId: string | null;
}

export function listEsignAgreements(
  applicationId: string
): Promise<{ agreements: EsignAgreement[] }> {
  return apiFetch<{ agreements: EsignAgreement[] }>(
    `/onboarding/applications/${applicationId}/esign/agreements`
  );
}

export function createEsignAgreement(
  applicationId: string,
  body: { title: string; body: string; taskId?: string | null }
): Promise<EsignAgreement> {
  return apiFetch<EsignAgreement>(
    `/onboarding/applications/${applicationId}/esign/agreements`,
    { method: 'POST', body }
  );
}

export function signEsignAgreement(
  applicationId: string,
  agreementId: string,
  body: { typedName: string }
): Promise<{ signedAt: string; signatureId: string }> {
  return apiFetch(
    `/onboarding/applications/${applicationId}/esign/agreements/${agreementId}/sign`,
    { method: 'POST', body }
  );
}

export function getApplication(id: string): Promise<ApplicationDetail> {
  return apiFetch<ApplicationDetail>(`/onboarding/applications/${id}`);
}

export function listTemplates(): Promise<TemplateListResponse> {
  return apiFetch<TemplateListResponse>('/onboarding/templates');
}

/* ---------------------- Phase 61 — template CRUD ----------------------- */

export function createTemplate(body: TemplateUpsertInput): Promise<OnboardingTemplate> {
  return apiFetch<OnboardingTemplate>('/onboarding/templates', {
    method: 'POST',
    body,
  });
}

export function updateTemplate(
  id: string,
  body: TemplateUpsertInput
): Promise<OnboardingTemplate> {
  return apiFetch<OnboardingTemplate>(`/onboarding/templates/${id}`, {
    method: 'PUT',
    body,
  });
}

export function deleteTemplate(id: string): Promise<void> {
  return apiFetch<void>(`/onboarding/templates/${id}`, { method: 'DELETE' });
}

export function getApplicationPolicies(
  applicationId: string
): Promise<ApplicationPoliciesResponse> {
  return apiFetch<ApplicationPoliciesResponse>(
    `/onboarding/applications/${applicationId}/policies`
  );
}

export function getApplicationAudit(
  applicationId: string
): Promise<AuditLogListResponse> {
  return apiFetch<AuditLogListResponse>(
    `/onboarding/applications/${applicationId}/audit`
  );
}

export function submitProfile(
  applicationId: string,
  body: ProfileSubmission
): Promise<void> {
  return apiFetch<void>(`/onboarding/applications/${applicationId}/profile`, {
    method: 'POST',
    body,
  });
}

export function submitW4(
  applicationId: string,
  body: W4SubmissionInput
): Promise<void> {
  return apiFetch<void>(`/onboarding/applications/${applicationId}/w4`, {
    method: 'POST',
    body,
  });
}

export interface W4Status {
  hasSubmission: boolean;
  filingStatus: 'SINGLE' | 'MARRIED_FILING_JOINTLY' | 'HEAD_OF_HOUSEHOLD' | null;
  multipleJobs: boolean;
  dependentsAmount: string | null;
  otherIncome: string | null;
  deductions: string | null;
  extraWithholding: string | null;
  hasSsnOnFile: boolean;
  ssnLast4: string | null;
  submittedAt: string | null;
}

export function getW4(applicationId: string): Promise<W4Status> {
  return apiFetch<W4Status>(`/onboarding/applications/${applicationId}/w4`);
}

export function submitDirectDeposit(
  applicationId: string,
  body: DirectDepositInput
): Promise<void> {
  return apiFetch<void>(
    `/onboarding/applications/${applicationId}/direct-deposit`,
    { method: 'POST', body }
  );
}

export interface DirectDepositStatus {
  hasPayoutMethod: boolean;
  type?: 'BANK_ACCOUNT' | 'BRANCH_CARD' | string | null;
  accountType?: 'CHECKING' | 'SAVINGS' | string | null;
  routingMasked?: string | null;
  accountLast4?: string | null;
  branchCardId?: string | null;
  verifiedAt?: string | null;
  updatedAt?: string | null;
}

export function getDirectDeposit(
  applicationId: string
): Promise<DirectDepositStatus> {
  return apiFetch<DirectDepositStatus>(
    `/onboarding/applications/${applicationId}/direct-deposit`
  );
}

export function acknowledgePolicy(
  applicationId: string,
  body: PolicyAckInput
): Promise<void> {
  return apiFetch<void>(`/onboarding/applications/${applicationId}/policy-ack`, {
    method: 'POST',
    body,
  });
}

export function skipTask(
  applicationId: string,
  taskId: string
): Promise<void> {
  return apiFetch<void>(
    `/onboarding/applications/${applicationId}/tasks/${taskId}/skip`,
    { method: 'POST' }
  );
}

/* ---------------------- Phase 63 — stub task completion ---------------- */

export function finishDocumentUpload(
  applicationId: string
): Promise<DocumentUploadCompleteResponse> {
  return apiFetch<DocumentUploadCompleteResponse>(
    `/onboarding/applications/${applicationId}/document-upload`,
    { method: 'POST', body: {} }
  );
}

export function authorizeBackgroundCheck(
  applicationId: string,
  body: BackgroundCheckAuthorizeInput
): Promise<BackgroundCheck> {
  return apiFetch<BackgroundCheck>(
    `/onboarding/applications/${applicationId}/background-check`,
    { method: 'POST', body }
  );
}

export function saveJ1Profile(
  applicationId: string,
  body: J1UpsertInput
): Promise<J1Profile> {
  return apiFetch<J1Profile>(
    `/onboarding/applications/${applicationId}/j1-profile`,
    { method: 'POST', body }
  );
}

export function finishJ1Docs(
  applicationId: string
): Promise<J1DocsCompleteResponse> {
  return apiFetch<J1DocsCompleteResponse>(
    `/onboarding/applications/${applicationId}/j1-finish`,
    { method: 'POST', body: {} }
  );
}
