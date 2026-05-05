import { apiFetch } from './api';

// Gap 10 — two-step approval (manager → HR/Finance) + payroll fold-in.
// SETTLED is what Phase 97 used to call APPROVED; MANAGER_APPROVED is the
// new intermediate state.
export type ReimbursementStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'MANAGER_APPROVED'
  | 'SETTLED'
  | 'REJECTED'
  | 'PAID';

export type ExpenseLineKind = 'RECEIPT' | 'MILEAGE' | 'PER_DIEM' | 'OTHER';

export interface ReimbursementSummary {
  id: string;
  associateId: string;
  associateName: string;
  title: string;
  description: string | null;
  totalAmount: string;
  currency: string;
  status: ReimbursementStatus;
  lineCount: number;
  submittedAt: string | null;
  managerApprovedAt: string | null;
  settledAt: string | null;
  decidedAt: string | null;
  paidAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface ExpenseLine {
  id: string;
  kind: ExpenseLineKind;
  description: string;
  incurredOn: string;
  amount: string;
  miles: string | null;
  ratePerMile: string | null;
  receiptUrl: string | null;
  merchant: string | null;
  category: string | null;
}

export interface ReimbursementFull extends Omit<ReimbursementSummary, 'lineCount'> {
  managerApprovedById: string | null;
  managerNote: string | null;
  settledById: string | null;
  settleNote: string | null;
  decidedById: string | null;
  payrollItemId: string | null;
  lines: ExpenseLine[];
}

export const listReimbursements = (params?: {
  associateId?: string;
  status?: ReimbursementStatus;
}) => {
  const q = new URLSearchParams();
  if (params?.associateId) q.set('associateId', params.associateId);
  if (params?.status) q.set('status', params.status);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ reimbursements: ReimbursementSummary[] }>(
    `/reimbursements${suffix}`,
  );
};

export const createReimbursement = (input: {
  title: string;
  description?: string | null;
  currency?: string;
}) => apiFetch<{ id: string }>('/reimbursements', { method: 'POST', body: input });

export const getReimbursement = (id: string) =>
  apiFetch<ReimbursementFull>(`/reimbursements/${id}`);

export const addExpenseLine = (
  id: string,
  input: {
    kind: ExpenseLineKind;
    description: string;
    incurredOn: string;
    amount: number;
    miles?: number | null;
    ratePerMile?: number | null;
    receiptUrl?: string | null;
    merchant?: string | null;
    category?: string | null;
  },
) =>
  apiFetch<{ id: string; totalAmount: string }>(`/reimbursements/${id}/lines`, {
    method: 'POST',
    body: input,
  });

export const deleteExpenseLine = (id: string) =>
  apiFetch<void>(`/expense-lines/${id}`, { method: 'DELETE' });

export const submitReimbursement = (id: string) =>
  apiFetch<{ ok: true }>(`/reimbursements/${id}/submit`, {
    method: 'POST',
    body: {},
  });

// Gap 10 — Manager step: SUBMITTED → MANAGER_APPROVED. Capability:
// approve:reimbursement (held by MANAGER, OPERATIONS_MANAGER, HR_ADMIN).
export const managerApproveReimbursement = (id: string, note?: string) =>
  apiFetch<{ ok: true }>(`/reimbursements/${id}/manager-approve`, {
    method: 'POST',
    body: { note: note ?? null },
  });

// Gap 10 — HR/Finance step: MANAGER_APPROVED → SETTLED. Capability:
// settle:reimbursement (held by HR_ADMIN, FINANCE_ACCOUNTANT). Pass
// waiveMissingReceipts+waiverNote to override the receipt-required guard.
export const settleReimbursement = (
  id: string,
  opts?: {
    note?: string;
    waiveMissingReceipts?: boolean;
    waiverNote?: string;
  },
) =>
  apiFetch<{ ok: true }>(`/reimbursements/${id}/settle`, {
    method: 'POST',
    body: opts ?? {},
  });

// Gap 10 — Manager OR HR can reject (depending on status). Reason required.
export const rejectReimbursement = (id: string, reason: string) =>
  apiFetch<{ ok: true }>(`/reimbursements/${id}/reject`, {
    method: 'POST',
    body: { reason },
  });

/**
 * Recommended categories for the UI dropdown. ExpenseLine.category is a
 * free-form string server-side; this is just a UI helper. HR can type
 * a custom category if none of these fit.
 */
export const RECOMMENDED_CATEGORIES = [
  'Meals',
  'Travel',
  'Lodging',
  'Supplies',
  'Equipment',
  'Training',
  'Mileage',
  'Other',
] as const;
