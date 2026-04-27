import type {
  ApplicationCreateInput,
  ApplicationDetail,
  ApplicationListResponse,
  ApplicationPoliciesResponse,
  AuditLogListResponse,
  BulkInviteInput,
  BulkInviteResponse,
  BulkResendInput,
  BulkResendResponse,
  ClientListResponse,
  DirectDepositInput,
  NudgeInput,
  NudgeResponse,
  PolicyAckInput,
  ProfileSubmission,
  TemplateListResponse,
  W4SubmissionInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export interface ListApplicationsFilters {
  status?: string;
  q?: string;
}

export function listApplications(
  filters: ListApplicationsFilters = {}
): Promise<ApplicationListResponse> {
  const p = new URLSearchParams();
  if (filters.status && filters.status !== 'ALL') p.set('status', filters.status);
  if (filters.q && filters.q.trim()) p.set('q', filters.q.trim());
  const qs = p.toString();
  return apiFetch<ApplicationListResponse>(
    `/onboarding/applications${qs ? `?${qs}` : ''}`
  );
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

export function getApplication(id: string): Promise<ApplicationDetail> {
  return apiFetch<ApplicationDetail>(`/onboarding/applications/${id}`);
}

export function listTemplates(): Promise<TemplateListResponse> {
  return apiFetch<TemplateListResponse>('/onboarding/templates');
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

export function submitDirectDeposit(
  applicationId: string,
  body: DirectDepositInput
): Promise<void> {
  return apiFetch<void>(
    `/onboarding/applications/${applicationId}/direct-deposit`,
    { method: 'POST', body }
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
