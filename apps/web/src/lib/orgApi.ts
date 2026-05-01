import type {
  AssociateOrgAssignmentInput,
  AssociateOrgListResponse,
  AssociateProfilePatchInput,
  CostCenter,
  CostCenterInput,
  CostCenterListResponse,
  Department,
  DepartmentInput,
  DepartmentListResponse,
  JobProfile,
  JobProfileInput,
  JobProfileListResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function patchAssociateProfile(
  associateId: string,
  input: AssociateProfilePatchInput,
): Promise<{ id: string; phone: string | null }> {
  return apiFetch(`/org/associates/${associateId}`, {
    method: 'PATCH',
    body: input,
  });
}

export function listDepartments(clientId?: string): Promise<DepartmentListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<DepartmentListResponse>(`/org/departments${q}`);
}
export function createDepartment(input: DepartmentInput): Promise<Department> {
  return apiFetch<Department>('/org/departments', { method: 'POST', body: input });
}
export function updateDepartment(
  id: string,
  input: Partial<DepartmentInput>,
): Promise<Department> {
  return apiFetch<Department>(`/org/departments/${id}`, { method: 'PUT', body: input });
}
export function deleteDepartment(id: string): Promise<void> {
  return apiFetch<void>(`/org/departments/${id}`, { method: 'DELETE' });
}

export function listCostCenters(clientId?: string): Promise<CostCenterListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<CostCenterListResponse>(`/org/cost-centers${q}`);
}
export function createCostCenter(input: CostCenterInput): Promise<CostCenter> {
  return apiFetch<CostCenter>('/org/cost-centers', { method: 'POST', body: input });
}
export function updateCostCenter(
  id: string,
  input: Partial<CostCenterInput>,
): Promise<CostCenter> {
  return apiFetch<CostCenter>(`/org/cost-centers/${id}`, { method: 'PUT', body: input });
}
export function deleteCostCenter(id: string): Promise<void> {
  return apiFetch<void>(`/org/cost-centers/${id}`, { method: 'DELETE' });
}

export function listJobProfiles(clientId?: string): Promise<JobProfileListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<JobProfileListResponse>(`/org/job-profiles${q}`);
}
export function createJobProfile(input: JobProfileInput): Promise<JobProfile> {
  return apiFetch<JobProfile>('/org/job-profiles', { method: 'POST', body: input });
}
export function updateJobProfile(
  id: string,
  input: Partial<JobProfileInput>,
): Promise<JobProfile> {
  return apiFetch<JobProfile>(`/org/job-profiles/${id}`, { method: 'PUT', body: input });
}
export function deleteJobProfile(id: string): Promise<void> {
  return apiFetch<void>(`/org/job-profiles/${id}`, { method: 'DELETE' });
}

export function listOrgAssociates(clientId?: string): Promise<AssociateOrgListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<AssociateOrgListResponse>(`/org/associates${q}`);
}
export function assignOrgFields(
  associateId: string,
  input: AssociateOrgAssignmentInput,
): Promise<{
  id: string;
  managerId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  jobProfileId: string | null;
}> {
  return apiFetch(`/org/associates/${associateId}/org`, {
    method: 'PUT',
    body: input,
  });
}

export interface AssociateHistoryEntry {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  managerId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  jobProfileId: string | null;
  state: string | null;
  hourlyRate: string | null;
  reason: string | null;
  actorEmail: string | null;
  createdAt: string;
}

export function listAssociateHistory(
  associateId: string,
): Promise<{ history: AssociateHistoryEntry[] }> {
  return apiFetch(`/org/associates/${associateId}/history`);
}

export function getAssociateAsOf(
  associateId: string,
  when?: string,
): Promise<{
  when: string;
  snapshot: {
    managerId: string | null;
    departmentId: string | null;
    costCenterId: string | null;
    jobProfileId: string | null;
    state: string | null;
    hourlyRate: string | null;
  } | null;
}> {
  const q = when ? `?when=${encodeURIComponent(when)}` : '';
  return apiFetch(`/org/associates/${associateId}/as-of${q}`);
}
