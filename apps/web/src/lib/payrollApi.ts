import type {
  PayrollConfig,
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

export function getPayrollConfig(year?: number): Promise<PayrollConfig> {
  const qs = year ? `?year=${year}` : '';
  return apiFetch<PayrollConfig>(`/payroll/config${qs}`);
}

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

// Gap 3 — destructive payroll ops. Both gated server-side on the new
// `void:payroll` capability (HR_ADMINISTRATOR only). UI hides these
// affordances unless the user has the capability.
export function voidPayrollRun(
  id: string,
  reason: string,
): Promise<PayrollRunDetail> {
  return apiFetch<PayrollRunDetail>(`/payroll/runs/${id}/void`, {
    method: 'POST',
    body: { reason },
  });
}

export interface AmendCorrection {
  associateId: string;
  hoursWorked: number;
  hourlyRate: number;
  grossPay: number;
  federalWithholding: number;
  fica: number;
  medicare: number;
  stateWithholding: number;
  preTaxDeductions?: number;
  postTaxDeductions?: number;
  employerFica?: number;
  employerMedicare?: number;
  employerFuta?: number;
  employerSuta?: number;
  taxState?: string | null;
}

export function amendPayrollRun(
  id: string,
  body: { reason: string; corrections: AmendCorrection[] },
): Promise<PayrollRunDetail> {
  return apiFetch<PayrollRunDetail>(`/payroll/runs/${id}/amend`, {
    method: 'POST',
    body,
  });
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

/**
 * Download an associate's own paystub PDF. The backend
 * (`GET /payroll/items/:id/paystub.pdf`) already authorizes the item owner,
 * so this works for self-service. Streams the PDF as a blob and triggers a
 * browser download using the filename the server supplies.
 */
export async function downloadMyPaystub(itemId: string): Promise<void> {
  const res = await fetch(`/api/payroll/items/${itemId}/paystub.pdf`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'Paystub not available.'
        : `Could not download paystub (${res.status}).`,
    );
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = m?.[1] ?? `paystub-${itemId.slice(0, 8)}.pdf`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

/* ===== Payroll readiness dashboard ====================================== */

export type ReadinessFlagKey =
  | 'w4OnFile'
  | 'taxStateSet'
  | 'payoutMethodOnFile'
  | 'payScheduleAssigned'
  | 'userLinked';

export interface PayrollReadinessRow {
  associateId: string;
  firstName: string;
  lastName: string;
  email: string;
  employmentType: 'W2_EMPLOYEE' | 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS';
  flags: Record<ReadinessFlagKey, boolean>;
  ready: boolean;
}

export interface PayrollReadinessResponse {
  total: number;
  readyCount: number;
  missingCount: number;
  rows: PayrollReadinessRow[];
}

export function getPayrollReadiness(): Promise<PayrollReadinessResponse> {
  return apiFetch<PayrollReadinessResponse>('/payroll/readiness');
}

/* ===== Branch webhook health =========================================== */

export type WebhookHealth =
  | 'healthy'
  | 'idle'
  | 'stale'
  | 'erroring'
  | 'unconfigured'
  | 'stub';

export interface DisbursementWebhookStatus {
  provider: 'STUB' | 'WISE' | 'BRANCH';
  health: WebhookHealth;
  detail: string;
  lastEventAt: string | null;
  minutesSinceLastEvent: number | null;
  eventsLast24h: number;
  errorsLast7d: number;
  pendingFinalizedItems: number;
  latestError: { at: string; eventType: string; notes: string | null } | null;
}

export function getDisbursementWebhookStatus(): Promise<DisbursementWebhookStatus> {
  return apiFetch<DisbursementWebhookStatus>('/payroll/disbursement/webhook-status');
}

/* ===== YTD per-associate report ======================================= */

export interface PayrollYtdRow {
  associateId: string;
  firstName: string;
  lastName: string;
  email: string;
  employmentType: string;
  gross: number;
  fit: number;
  fica: number;
  medicare: number;
  sit: number;
  preTax: number;
  postTax: number;
  net: number;
  paystubCount: number;
}

export interface PayrollYtdResponse {
  taxYear: number;
  totals: {
    gross: number;
    fit: number;
    fica: number;
    medicare: number;
    sit: number;
    preTax: number;
    postTax: number;
    net: number;
    associateCount: number;
    paystubCount: number;
  };
  rows: PayrollYtdRow[];
}

export function getPayrollYtd(year?: number): Promise<PayrollYtdResponse> {
  const qs = year ? `?year=${year}` : '';
  return apiFetch<PayrollYtdResponse>(`/payroll/ytd${qs}`);
}

/* ===== Year-end close checklist ======================================== */

export interface YearEndCheck {
  key: string;
  label: string;
  done: boolean;
  detail: string;
  href: string;
}

export interface YearEndCloseResponse {
  taxYear: number;
  readyToClose: boolean;
  checks: YearEndCheck[];
}

export function getYearEndClose(year?: number): Promise<YearEndCloseResponse> {
  const qs = year ? `?year=${year}` : '';
  return apiFetch<YearEndCloseResponse>(`/payroll/year-end-close${qs}`);
}
