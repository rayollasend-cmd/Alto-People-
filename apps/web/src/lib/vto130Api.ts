import { apiFetch } from './api';

export type VtoStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'MATCHED';

export interface MyVolunteerEntry {
  id: string;
  activityDate: string;
  hours: string;
  organization: string;
  cause: string | null;
  description: string;
  evidenceUrl: string | null;
  matchRequested: boolean;
  matchAmount: string | null;
  matchCurrency: string;
  status: VtoStatus;
  reviewerNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MyVolunteerResponse {
  entries: MyVolunteerEntry[];
  year: number | null;
  capHours: number;
  usedHours: number;
  matchRatio: number;
  matchCurrency: string;
}

export interface QueueVolunteerEntry extends MyVolunteerEntry {
  associateId: string;
  associateName: string;
  associateEmail: string;
  reviewedByEmail: string | null;
}

export interface VolunteerSummary {
  pendingCount: number;
  hoursYtd: string;
  matchedAmountYtd: string;
}

export interface VtoPolicy {
  policy: {
    id: string;
    clientId: string | null;
    annualHoursCap: string;
    matchRatio: string;
    matchCurrency: string;
  } | null;
  effective: {
    annualHoursCap: string;
    matchRatio: string;
    matchCurrency: string;
  };
}

export const submitVolunteerEntry = (input: {
  activityDate: string;
  hours: number;
  organization: string;
  cause?: string | null;
  description: string;
  evidenceUrl?: string | null;
  matchRequested?: boolean;
}) =>
  apiFetch<{ id: string }>('/volunteer-entries', {
    method: 'POST',
    body: input,
  });

export const listMyVolunteer = (year?: number) =>
  apiFetch<MyVolunteerResponse>(
    `/my/volunteer-entries${year ? `?year=${year}` : ''}`,
  );

export const listVolunteerQueue = (status?: VtoStatus) =>
  apiFetch<{ entries: QueueVolunteerEntry[] }>(
    `/volunteer-entries${status ? `?status=${status}` : ''}`,
  );

export const decideVolunteerEntry = (
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  notes?: string,
) =>
  apiFetch<{ ok: true }>(`/volunteer-entries/${id}/decide`, {
    method: 'POST',
    body: { decision, notes: notes ?? null },
  });

export const matchVolunteerEntry = (id: string, amount?: number) =>
  apiFetch<{ ok: true }>(`/volunteer-entries/${id}/match`, {
    method: 'POST',
    body: amount != null ? { amount } : {},
  });

export const getVtoPolicy = (clientId?: string) =>
  apiFetch<VtoPolicy>(
    `/vto-policy${clientId ? `?clientId=${clientId}` : ''}`,
  );

export const setVtoPolicy = (input: {
  clientId?: string | null;
  annualHoursCap: number;
  matchRatio: number;
  matchCurrency?: string;
}) =>
  apiFetch<{ ok: true }>('/vto-policy', { method: 'PUT', body: input });

export const getVolunteerSummary = () =>
  apiFetch<VolunteerSummary>('/volunteer-summary');
