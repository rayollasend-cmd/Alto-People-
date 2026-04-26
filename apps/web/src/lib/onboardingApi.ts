import type {
  ApplicationDetail,
  ApplicationListResponse,
  ApplicationPoliciesResponse,
  AuditLogListResponse,
  DirectDepositInput,
  PolicyAckInput,
  ProfileSubmission,
  TemplateListResponse,
  W4SubmissionInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listApplications(): Promise<ApplicationListResponse> {
  return apiFetch<ApplicationListResponse>('/onboarding/applications');
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
