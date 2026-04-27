import type {
  BenefitsEnrollInput,
  BenefitsEnrollment,
  BenefitsEnrollmentListResponse,
  BenefitsPlan,
  BenefitsPlanCreateInput,
  BenefitsPlanListResponse,
  BenefitsPlanUpdateInput,
  BenefitsTerminateInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listPlans(
  params: { clientId: string; includeInactive?: boolean }
): Promise<BenefitsPlanListResponse> {
  const sp = new URLSearchParams({ clientId: params.clientId });
  if (params.includeInactive) sp.set('includeInactive', 'true');
  return apiFetch<BenefitsPlanListResponse>(`/benefits/plans?${sp.toString()}`);
}

export function createPlan(body: BenefitsPlanCreateInput): Promise<BenefitsPlan> {
  return apiFetch<BenefitsPlan>('/benefits/plans', { method: 'POST', body });
}

export function updatePlan(
  id: string,
  body: BenefitsPlanUpdateInput
): Promise<BenefitsPlan> {
  return apiFetch<BenefitsPlan>(`/benefits/plans/${id}`, { method: 'PATCH', body });
}

export function listMyEnrollments(): Promise<BenefitsEnrollmentListResponse> {
  return apiFetch<BenefitsEnrollmentListResponse>('/benefits/me/enrollments');
}

export function enrollMe(body: BenefitsEnrollInput): Promise<BenefitsEnrollment> {
  return apiFetch<BenefitsEnrollment>('/benefits/me/enrollments', {
    method: 'POST',
    body,
  });
}

export function terminateMyEnrollment(
  id: string,
  body: BenefitsTerminateInput
): Promise<BenefitsEnrollment> {
  return apiFetch<BenefitsEnrollment>(
    `/benefits/me/enrollments/${id}/terminate`,
    { method: 'POST', body }
  );
}
