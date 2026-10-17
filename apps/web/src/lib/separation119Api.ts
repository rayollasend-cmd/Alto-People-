import { apiFetch } from './api';

export type SeparationReason =
  | 'VOLUNTARY_OTHER_OPPORTUNITY'
  | 'VOLUNTARY_PERSONAL'
  | 'VOLUNTARY_RELOCATION'
  | 'VOLUNTARY_RETIREMENT'
  | 'INVOLUNTARY_PERFORMANCE'
  | 'INVOLUNTARY_LAYOFF'
  | 'INVOLUNTARY_MISCONDUCT'
  | 'END_OF_CONTRACT'
  | 'DECEASED'
  | 'OTHER';

export type SeparationStatus = 'PLANNED' | 'IN_PROGRESS' | 'COMPLETE';

export interface SeparationRow {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  reason: SeparationReason;
  status: SeparationStatus;
  noticeDate: string | null;
  lastDayWorked: string;
  finalPaycheckDate: string | null;
  rating: number | null;
  reasonNotes: string | null;
  feedbackPositive: string | null;
  feedbackImprovement: string | null;
  wouldRecommend: boolean | null;
  wouldReturn: boolean | null;
  exitInterviewCompletedAt: string | null;
  initiatedByEmail: string | null;
  completedByEmail: string | null;
  completedAt: string | null;
}

export interface SeparationSummary {
  days: number;
  planned: number;
  inProgress: number;
  completedInWindow: number;
  exitInterviewCompletedInWindow: number;
  averageRating: number | null;
  byReason: Record<string, number>;
}

export const REASON_LABELS: Record<SeparationReason, string> = {
  VOLUNTARY_OTHER_OPPORTUNITY: 'Voluntary — other opportunity',
  VOLUNTARY_PERSONAL: 'Voluntary — personal',
  VOLUNTARY_RELOCATION: 'Voluntary — relocation',
  VOLUNTARY_RETIREMENT: 'Voluntary — retirement',
  INVOLUNTARY_PERFORMANCE: 'Involuntary — performance',
  INVOLUNTARY_LAYOFF: 'Involuntary — layoff',
  INVOLUNTARY_MISCONDUCT: 'Involuntary — misconduct',
  END_OF_CONTRACT: 'End of contract',
  DECEASED: 'Deceased',
  OTHER: 'Other',
};

export const listSeparations = (params: {
  status?: SeparationStatus;
  reason?: SeparationReason;
}) => {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.reason) q.set('reason', params.reason);
  const qs = q.toString();
  return apiFetch<{ separations: SeparationRow[] }>(
    `/separations${qs ? `?${qs}` : ''}`,
  );
};

export const getSeparationSummary = (days = 90) =>
  apiFetch<SeparationSummary>(`/separations/summary?days=${days}`);

export const initiateSeparation = (input: {
  associateId: string;
  reason: SeparationReason;
  noticeDate?: string | null;
  lastDayWorked: string;
  finalPaycheckDate?: string | null;
}) =>
  apiFetch<{ id: string }>('/separations', { method: 'POST', body: input });

/** Completing may answer 202 — it went to a second person (approval engine). */
export const advanceSeparation = (id: string) =>
  apiFetch<{ ok: true; status: SeparationStatus } | { pending: true; approvalId: string; title: string }>(
    `/separations/${id}/advance`,
    { method: 'POST', body: {} },
  );

export const submitExitInterview = (
  id: string,
  input: {
    rating?: number | null;
    reasonNotes?: string | null;
    feedbackPositive?: string | null;
    feedbackImprovement?: string | null;
    wouldRecommend?: boolean | null;
    wouldReturn?: boolean | null;
  },
) =>
  apiFetch<{ ok: true }>(`/separations/${id}/exit-interview`, {
    method: 'POST',
    body: input,
  });

/** Offboarding (GET /separations/:id/offboarding): the final-pay preview, assets out, access. */
export interface Offboarding {
  separationId: string;
  associateName: string;
  finalPay: {
    computedAt: string;
    state: string | null;
    rate: number | null;
    payType: 'HOURLY' | 'SALARY' | null;
    paidThrough: string | null;
    unpaidApprovedHours: number;
    awaitingApprovalHours: number;
    leavePayoutHours: number;
    leaveBalances: Array<{ category: string; hours: number; paidOut: boolean }>;
    estimatedGross: number | null;
    deadline: { date: string | null; basis: string; note: string; minimumWageCents: number };
    paySchedule: { name: string; frequency: string } | null;
    finalPaycheckDate: string | null;
    finalPaycheckLate: boolean;
  };
  assets: {
    outstanding: Array<{ assignmentId: string; assetId: string; kind: string; label: string; serial: string | null; assignedAt: string }>;
    waivedAt: string | null;
    waiveReason: string | null;
    clear: boolean;
  };
  access: { removed: boolean; activeLogins: number };
}

export const getOffboarding = (id: string) => apiFetch<Offboarding>(`/separations/${id}/offboarding`);
export const waiveSeparationAssets = (id: string, reason: string) =>
  apiFetch<{ ok: true }>(`/separations/${id}/assets/waive`, { method: 'POST', body: { reason } });
