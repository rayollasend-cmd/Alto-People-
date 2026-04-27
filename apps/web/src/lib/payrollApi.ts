import type {
  PayrollItemListResponse,
  PayrollRunCreateInput,
  PayrollRunDetail,
  PayrollRunListResponse,
  PayrollRunStatus,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listPayrollRuns(
  filters: { status?: PayrollRunStatus } = {}
): Promise<PayrollRunListResponse> {
  const qs = filters.status ? `?status=${filters.status}` : '';
  return apiFetch<PayrollRunListResponse>(`/payroll/runs${qs}`);
}

export function getPayrollRun(id: string): Promise<PayrollRunDetail> {
  return apiFetch<PayrollRunDetail>(`/payroll/runs/${id}`);
}

export function createPayrollRun(body: PayrollRunCreateInput): Promise<PayrollRunDetail> {
  return apiFetch<PayrollRunDetail>('/payroll/runs', { method: 'POST', body });
}

export function finalizePayrollRun(id: string): Promise<PayrollRunDetail> {
  return apiFetch<PayrollRunDetail>(`/payroll/runs/${id}/finalize`, { method: 'POST' });
}

export function disbursePayrollRun(id: string): Promise<PayrollRunDetail> {
  return apiFetch<PayrollRunDetail>(`/payroll/runs/${id}/disburse`, { method: 'POST' });
}

export function retryRunFailures(
  id: string
): Promise<{ retried: number; succeeded: number }> {
  return apiFetch<{ retried: number; succeeded: number }>(
    `/payroll/runs/${id}/retry-failures`,
    { method: 'POST' }
  );
}

export interface BranchEnrollment {
  associateId: string;
  firstName: string;
  lastName: string;
  hasBankAccount: boolean;
  branchCardId: string | null;
  accountType: string | null;
  rail: 'BRANCH_CARD' | 'BANK_ACCOUNT' | 'NONE';
}

export function getBranchEnrollment(associateId: string): Promise<BranchEnrollment> {
  return apiFetch<BranchEnrollment>(
    `/payroll/associates/${associateId}/branch-enrollment`
  );
}

export function setBranchEnrollment(
  associateId: string,
  branchCardId: string | null
): Promise<{ ok: true; branchCardId: string | null }> {
  return apiFetch<{ ok: true; branchCardId: string | null }>(
    `/payroll/associates/${associateId}/branch-enrollment`,
    { method: 'PATCH', body: { branchCardId } }
  );
}

export function listMyPayrollItems(): Promise<PayrollItemListResponse> {
  return apiFetch<PayrollItemListResponse>('/payroll/me/items');
}
