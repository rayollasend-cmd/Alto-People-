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

/** The plans the signed-in associate can elect — the server resolves their client from their placement. */
export function listMyPlans(): Promise<{ client: { id: string; name: string } | null; plans: BenefitsPlan[] }> {
  return apiFetch('/benefits/plans/mine');
}

export interface BenefitsOverviewPlan {
  id: string;
  clientId: string;
  name: string;
  kind: BenefitsPlan['kind'];
  isActive: boolean;
  enrolled: number;
  employeeCentsPerPeriod: number;
  employerCentsPerPeriod: number;
}

export interface BenefitsOverview {
  totals: {
    activePlans: number;
    enrolledPeople: number;
    employeeCentsPerPeriod: number;
    employerCentsPerPeriod: number;
    lifeEventsWaiting: number;
    cobraPending: number;
  };
  clients: Array<{ clientId: string; clientName: string; plans: BenefitsOverviewPlan[] }>;
  openEnrollment: Array<{ id: string; clientId: string; clientName: string; name: string; status: 'DRAFT' | 'OPEN'; startsOn: string; endsOn: string; effectiveOn: string }>;
  /** Only for people who send carrier files (process:payroll). */
  carriers?: Array<{ id: string; name: string; active: boolean; members: number; lastFile: { createdAt: string; mode: string; status: string; controlNumber: number; memberCount: number } | null }>;
}

/** The benefits desk: plans by client, who's enrolled, what's waiting (HR and finance). */
export function getBenefitsOverview(): Promise<BenefitsOverview> {
  return apiFetch<BenefitsOverview>('/benefits/overview');
}
