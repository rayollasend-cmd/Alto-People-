import type {
  PayrollExceptionsInput,
  PayrollExceptionsResponse,
  PayrollItemListResponse,
  PayrollRunCreateInput,
  PayrollRunDetail,
  PayrollRunListResponse,
  PayrollRunPreviewResponse,
  PayrollRunStatus,
  PayrollSchedule,
  PayrollScheduleCreateInput,
  PayrollScheduleListResponse,
  PayrollScheduleUpdateInput,
  PayrollUpcomingSummary,
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

export function previewPayrollRun(body: PayrollRunCreateInput): Promise<PayrollRunPreviewResponse> {
  return apiFetch<PayrollRunPreviewResponse>('/payroll/runs/preview', { method: 'POST', body });
}

/* ===== Wave 8 — exception triage + landing summary ===================== */

export function listPayrollExceptions(
  body: PayrollExceptionsInput
): Promise<PayrollExceptionsResponse> {
  return apiFetch<PayrollExceptionsResponse>('/payroll/runs/exceptions', {
    method: 'POST',
    body,
  });
}

export function getPayrollUpcoming(): Promise<PayrollUpcomingSummary> {
  return apiFetch<PayrollUpcomingSummary>('/payroll/upcoming');
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

/* ===== Wave 1.1 — Pay schedules ======================================== */

export function listPayrollSchedules(
  opts: { includeInactive?: boolean } = {}
): Promise<PayrollScheduleListResponse> {
  const qs = opts.includeInactive ? '?includeInactive=true' : '';
  return apiFetch<PayrollScheduleListResponse>(`/payroll/schedules${qs}`);
}

export function createPayrollSchedule(body: PayrollScheduleCreateInput): Promise<PayrollSchedule> {
  return apiFetch<PayrollSchedule>('/payroll/schedules', { method: 'POST', body });
}

export function updatePayrollSchedule(
  id: string,
  body: PayrollScheduleUpdateInput
): Promise<PayrollSchedule> {
  return apiFetch<PayrollSchedule>(`/payroll/schedules/${id}`, { method: 'PATCH', body });
}

export function deletePayrollSchedule(id: string): Promise<void> {
  return apiFetch<void>(`/payroll/schedules/${id}`, { method: 'DELETE' });
}

export function assignPayrollSchedule(
  id: string,
  associateIds: string[]
): Promise<{ assigned: number }> {
  return apiFetch<{ assigned: number }>(
    `/payroll/schedules/${id}/assign`,
    { method: 'POST', body: { associateIds } }
  );
}
