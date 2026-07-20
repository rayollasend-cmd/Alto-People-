import type {
  AssociateOrgAssignmentInput,
  AssociateOrgListResponse,
  AssociateProfilePatchInput,
  AssociateTransferInput,
  AssociateTransferResponse,
  CostCenter,
  CostCenterInput,
  CostCenterListResponse,
  Department,
  DepartmentInput,
  DepartmentListResponse,
  JobProfile,
  JobProfileInput,
  JobProfileListResponse,
  ShiftPosition,
  ShiftPositionInput,
  ShiftPositionListResponse,
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

export function transferAssociate(
  associateId: string,
  input: AssociateTransferInput,
): Promise<AssociateTransferResponse> {
  return apiFetch<AssociateTransferResponse>(
    `/org/associates/${associateId}/transfer`,
    { method: 'POST', body: input },
  );
}

export interface PayoutMethodSummary {
  hasPayoutMethod: boolean;
  type?: 'BANK_ACCOUNT' | 'BRANCH_CARD';
  accountType?: string | null;
  routingMasked?: string | null;
  accountLast4?: string | null;
  branchCardId?: string | null;
  verifiedAt?: string | null;
  updatedAt?: string | null;
}

export interface PayoutMethodReveal {
  type: 'BANK_ACCOUNT' | 'BRANCH_CARD';
  accountType: string | null;
  routingNumber: string | null;
  accountNumber: string | null;
  branchCardId: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
}

export function getAssociatePayoutMethod(
  associateId: string,
): Promise<PayoutMethodSummary> {
  return apiFetch(`/org/associates/${associateId}/payout-method`);
}

export function revealAssociatePayoutMethod(
  associateId: string,
  reason: string,
): Promise<PayoutMethodReveal> {
  return apiFetch(`/org/associates/${associateId}/payout-method/reveal`, {
    method: 'POST',
    body: { reason },
  });
}

export interface SsnSummary {
  hasSsn: boolean;
  ssnLast4: string | null;
  /** W4 = W-2 employee's W-4 submission; TIN = 1099 contractor's TIN. */
  source: 'W4' | 'TIN' | null;
}

export interface SsnReveal {
  kind: 'SSN' | 'EIN';
  source: 'W4' | 'TIN';
  number: string;
}

export function getAssociateSsn(associateId: string): Promise<SsnSummary> {
  return apiFetch(`/org/associates/${associateId}/ssn`);
}

/** Audited full-number reveal — requires a written reason; every call
 *  lands an AuditLog row before the number is returned. */
export function revealAssociateSsn(
  associateId: string,
  reason: string,
): Promise<SsnReveal> {
  return apiFetch(`/org/associates/${associateId}/ssn/reveal`, {
    method: 'POST',
    body: { reason },
  });
}

/**
 * Bulk payroll-provider census export. Streams a CSV of every ACTIVE
 * associate's decrypted SSN + bank details and triggers a browser download.
 *
 * This is the most sensitive export in the app: it requires process:payroll,
 * a written reason (min 8 chars), and the server writes one audit row naming
 * the actor, the reason, and every associate in the file BEFORE the download
 * streams. Returns the row count so the caller can confirm what was pulled.
 *
 * Hand the file to the provider's secure portal — never email it — and delete
 * the local copy once the import is confirmed.
 */
export async function downloadPayrollCensus(
  reason: string,
): Promise<{ rowCount: number; decryptFailures: number }> {
  const res = await fetch('/api/org/associates/payroll-census-export', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    let message = `Could not export census (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body — keep the default */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = m?.[1] ?? 'payroll-census.csv';
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return {
    rowCount: Number(res.headers.get('x-row-count') ?? 0),
    decryptFailures: Number(res.headers.get('x-decrypt-failures') ?? 0),
  };
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

export function listShiftPositions(
  clientId?: string,
): Promise<ShiftPositionListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<ShiftPositionListResponse>(`/org/shift-positions${q}`);
}
export function createShiftPosition(
  input: ShiftPositionInput,
): Promise<ShiftPosition> {
  return apiFetch<ShiftPosition>('/org/shift-positions', {
    method: 'POST',
    body: input,
  });
}
export function updateShiftPosition(
  id: string,
  input: Partial<ShiftPositionInput>,
): Promise<ShiftPosition> {
  return apiFetch<ShiftPosition>(`/org/shift-positions/${id}`, {
    method: 'PUT',
    body: input,
  });
}
export function deleteShiftPosition(id: string): Promise<void> {
  return apiFetch<void>(`/org/shift-positions/${id}`, { method: 'DELETE' });
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
