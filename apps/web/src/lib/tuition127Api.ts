import { apiFetch } from './api';

export type TuitionStatus = 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'PAID';

export interface MyTuitionRequest {
  id: string;
  schoolName: string;
  programName: string | null;
  courseName: string;
  termStartDate: string;
  termEndDate: string;
  amount: string;
  currency: string;
  status: TuitionStatus;
  receiptUrl: string | null;
  gradeReceived: string | null;
  reviewerNotes: string | null;
  reviewedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface QueueTuitionRequest extends MyTuitionRequest {
  associateId: string;
  associateName: string;
  associateEmail: string;
  reviewedByEmail: string | null;
  paidByEmail: string | null;
}

export interface TuitionSummary {
  pendingCount: number;
  approvedAwaitingPayment: number;
  paidYtdAmount: string;
}

export const submitTuitionRequest = (input: {
  schoolName: string;
  programName?: string | null;
  courseName: string;
  termStartDate: string;
  termEndDate: string;
  amount: number;
  currency?: string;
  receiptUrl?: string | null;
}) =>
  apiFetch<{ id: string }>('/tuition-requests', {
    method: 'POST',
    body: input,
  });

export const listMyTuition = () =>
  apiFetch<{ requests: MyTuitionRequest[] }>('/my/tuition-requests');

export const setTuitionGrade = (id: string, gradeReceived: string) =>
  apiFetch<{ ok: true }>(`/tuition-requests/${id}/grade`, {
    method: 'POST',
    body: { gradeReceived },
  });

export const listTuitionQueue = (status?: TuitionStatus) =>
  apiFetch<{ requests: QueueTuitionRequest[] }>(
    `/tuition-requests${status ? `?status=${status}` : ''}`,
  );

export const decideTuition = (
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  notes?: string,
) =>
  apiFetch<{ ok: true }>(`/tuition-requests/${id}/decide`, {
    method: 'POST',
    body: { decision, notes: notes ?? null },
  });

export const payTuition = (id: string) =>
  apiFetch<{ ok: true }>(`/tuition-requests/${id}/pay`, {
    method: 'POST',
    body: {},
  });

export const getTuitionSummary = () =>
  apiFetch<TuitionSummary>('/tuition-summary');
