import { apiFetch } from './api';

export type ReimbursementStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
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
  apiFetch<{ id: string }>(`/reimbursements/${id}/lines`, {
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

export const decideReimbursement = (
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  reason?: string,
) =>
  apiFetch<{ ok: true }>(`/reimbursements/${id}/decide`, {
    method: 'POST',
    body: { decision, reason },
  });

export const markPaidReimbursement = (id: string, payrollRunId?: string) =>
  apiFetch<{ ok: true }>(`/reimbursements/${id}/mark-paid`, {
    method: 'POST',
    body: { payrollRunId: payrollRunId ?? null },
  });
