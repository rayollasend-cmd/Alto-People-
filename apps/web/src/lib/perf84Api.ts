import { apiFetch } from './api';

export type GoalKind = 'GOAL' | 'OBJECTIVE';
export type GoalStatus = 'DRAFT' | 'ACTIVE' | 'AT_RISK' | 'COMPLETED' | 'CANCELLED';

export interface KeyResult {
  id: string;
  title: string;
  targetValue: string | null;
  currentValue: string;
  unit: string | null;
  progressPct: number;
}

export interface Goal {
  id: string;
  associateId: string;
  kind: GoalKind;
  title: string;
  description: string | null;
  parentGoalId: string | null;
  periodStart: string;
  periodEnd: string;
  status: GoalStatus;
  progressPct: number;
  keyResults: KeyResult[];
}

export type OneOnOneStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
export interface OneOnOne {
  id: string;
  associateId: string;
  managerUserId: string;
  scheduledFor: string;
  completedAt: string | null;
  agenda: string | null;
  managerNotes: string | null;
  associateNotes: string | null;
  status: OneOnOneStatus;
}

export interface Kudo {
  id: string;
  fromUserEmail: string;
  toAssociateName: string;
  message: string;
  tags: string[];
  isPublic: boolean;
  createdAt: string;
}

export type PipStatus = 'DRAFT' | 'ACTIVE' | 'PASSED' | 'FAILED' | 'CANCELLED';
export interface Pip {
  id: string;
  associateId: string;
  managerUserId: string | null;
  startDate: string;
  endDate: string;
  reason: string;
  expectations: string;
  supportPlan: string | null;
  status: PipStatus;
  outcomeNote: string | null;
  decidedAt: string | null;
}

export type Review360Status = 'COLLECTING' | 'COMPLETED' | 'CANCELLED';
export interface Review360 {
  id: string;
  subjectAssociateId: string;
  requestedById: string | null;
  periodStart: string;
  periodEnd: string;
  status: Review360Status;
  feedbackCount: number;
}

// Goals
export const listGoals = (associateId?: string) =>
  apiFetch<{ goals: Goal[] }>(
    associateId ? `/performance/goals?associateId=${associateId}` : '/performance/goals',
  );
export const createGoal = (input: {
  associateId: string;
  kind?: GoalKind;
  title: string;
  description?: string | null;
  parentGoalId?: string | null;
  periodStart: string;
  periodEnd: string;
}) => apiFetch<{ id: string }>('/performance/goals', { method: 'POST', body: input });
export const updateGoal = (
  id: string,
  input: {
    title?: string;
    description?: string | null;
    status?: GoalStatus;
    progressPct?: number;
  },
) => apiFetch<{ ok: true }>(`/performance/goals/${id}`, { method: 'PUT', body: input });
export const deleteGoal = (id: string) =>
  apiFetch<void>(`/performance/goals/${id}`, { method: 'DELETE' });
export const createKeyResult = (
  goalId: string,
  input: { title: string; targetValue?: number | null; unit?: string | null },
) =>
  apiFetch<{ id: string }>(`/performance/goals/${goalId}/key-results`, {
    method: 'POST',
    body: input,
  });
export const updateKeyResult = (
  id: string,
  input: { title?: string; currentValue?: number; progressPct?: number },
) =>
  apiFetch<{ ok: true }>(`/performance/key-results/${id}`, {
    method: 'PUT',
    body: input,
  });

// 1:1
export const listOneOnOnes = (associateId?: string) =>
  apiFetch<{ meetings: OneOnOne[] }>(
    associateId
      ? `/performance/one-on-ones?associateId=${associateId}`
      : '/performance/one-on-ones',
  );
export const createOneOnOne = (input: {
  associateId: string;
  managerUserId: string;
  scheduledFor: string;
  agenda?: string | null;
}) => apiFetch<{ id: string }>('/performance/one-on-ones', { method: 'POST', body: input });
export const updateOneOnOne = (
  id: string,
  input: {
    agenda?: string | null;
    managerNotes?: string | null;
    associateNotes?: string | null;
    status?: OneOnOneStatus;
  },
) =>
  apiFetch<{ ok: true }>(`/performance/one-on-ones/${id}`, {
    method: 'PUT',
    body: input,
  });

// Kudos
export const listKudos = (params?: { toAssociateId?: string; onlyPublic?: boolean }) => {
  const q = new URLSearchParams();
  if (params?.toAssociateId) q.set('toAssociateId', params.toAssociateId);
  if (params?.onlyPublic) q.set('onlyPublic', '1');
  const qs = q.toString();
  return apiFetch<{ kudos: Kudo[] }>(
    qs ? `/performance/kudos?${qs}` : '/performance/kudos',
  );
};
export const createKudo = (input: {
  toAssociateId: string;
  message: string;
  tags?: string[];
  isPublic?: boolean;
}) => apiFetch<{ id: string }>('/performance/kudos', { method: 'POST', body: input });

// PIPs
export const listPips = (associateId?: string) =>
  apiFetch<{ pips: Pip[] }>(
    associateId ? `/performance/pips?associateId=${associateId}` : '/performance/pips',
  );
export const createPip = (input: {
  associateId: string;
  startDate: string;
  endDate: string;
  reason: string;
  expectations: string;
  supportPlan?: string | null;
}) => apiFetch<{ id: string }>('/performance/pips', { method: 'POST', body: input });
export const updatePip = (
  id: string,
  input: {
    status?: PipStatus;
    outcomeNote?: string | null;
    expectations?: string;
    supportPlan?: string | null;
  },
) => apiFetch<{ ok: true }>(`/performance/pips/${id}`, { method: 'PUT', body: input });

// 360s
export const listReviews360 = (subjectAssociateId?: string) =>
  apiFetch<{ reviews: Review360[] }>(
    subjectAssociateId
      ? `/performance/reviews360?subjectAssociateId=${subjectAssociateId}`
      : '/performance/reviews360',
  );
export const createReview360 = (input: {
  subjectAssociateId: string;
  periodStart: string;
  periodEnd: string;
}) => apiFetch<{ id: string }>('/performance/reviews360', { method: 'POST', body: input });
export const submitFeedback = (
  reviewId: string,
  input: {
    isAnonymous?: boolean;
    strengths?: string | null;
    improvements?: string | null;
    rating?: number | null;
  },
) =>
  apiFetch<{ ok: true }>(`/performance/reviews360/${reviewId}/feedback`, {
    method: 'POST',
    body: input,
  });
export const getAggregate = (reviewId: string) =>
  apiFetch<{
    count: number;
    averageRating: number | null;
    entries: Array<{
      id: string;
      isAnonymous: boolean;
      strengths: string | null;
      improvements: string | null;
      rating: number | null;
      submittedAt: string;
    }>;
  }>(`/performance/reviews360/${reviewId}/aggregate`);
export const closeReview360 = (id: string) =>
  apiFetch<{ ok: true }>(`/performance/reviews360/${id}/close`, {
    method: 'PUT',
    body: {},
  });
