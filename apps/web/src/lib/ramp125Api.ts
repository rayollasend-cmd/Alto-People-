import { apiFetch } from './api';

export type RampMilestoneStatus = 'PENDING' | 'ON_TRACK' | 'ACHIEVED' | 'MISSED';

export interface RampMilestone {
  id: string;
  dayCheckpoint: number;
  title: string;
  description: string | null;
  status: RampMilestoneStatus;
  achievedAt: string | null;
  notes: string | null;
}

export interface RampPlan {
  id: string;
  associateId: string;
  associateName: string;
  startDate: string;
  managerEmail: string | null;
  notes: string | null;
  milestones: RampMilestone[];
}

export interface RampPlanRow {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  startDate: string;
  managerEmail: string | null;
  managerName?: string | null;
  template?: RampTemplate;
  total: number;
  achieved: number;
  missed: number;
  /** Each checkpoint and how it went — the row's timeline. */
  milestones?: Array<{ dayCheckpoint: number; status: RampMilestoneStatus; title: string }>;
}

export type RampTemplate = 'STANDARD' | 'SEASONAL';

export const TEMPLATE_LABELS: Record<RampTemplate, string> = {
  STANDARD: 'Standard — first shift to day 90',
  SEASONAL: 'Seasonal — a 6–8 week season',
};

export interface RampOwner {
  id: string;
  name: string;
  role: string;
  siteName: string | null;
}

export const listRampOwners = () => apiFetch<{ owners: RampOwner[] }>('/ramp-plans/owners');

export const STATUS_LABELS: Record<RampMilestoneStatus, string> = {
  PENDING: 'Pending',
  ON_TRACK: 'On track',
  ACHIEVED: 'Achieved',
  MISSED: 'Missed',
};

export const listRampPlans = () =>
  apiFetch<{ plans: RampPlanRow[] }>('/ramp-plans');

export const getActivePlanForAssociate = (associateId: string) =>
  apiFetch<{ plan: RampPlan | null }>(
    `/ramp-plans/by-associate/${associateId}`,
  );

export const createRampPlan = (input: {
  associateId: string;
  startDate: string;
  managerId?: string | null;
  notes?: string | null;
  template?: RampTemplate;
  milestones?: { dayCheckpoint: number; title: string; description?: string | null }[];
}) =>
  apiFetch<{ id: string }>('/ramp-plans', { method: 'POST', body: input });

export const addMilestone = (
  planId: string,
  input: {
    dayCheckpoint: number;
    title: string;
    description?: string | null;
  },
) =>
  apiFetch<{ id: string }>(`/ramp-plans/${planId}/milestones`, {
    method: 'POST',
    body: input,
  });

export const updateMilestone = (
  id: string,
  input: Partial<{
    status: RampMilestoneStatus;
    notes: string | null;
    title: string;
    description: string | null;
  }>,
) =>
  apiFetch<{ ok: true }>(`/ramp-milestones/${id}`, {
    method: 'PATCH',
    body: input,
  });

export const deleteMilestone = (id: string) =>
  apiFetch<void>(`/ramp-milestones/${id}`, { method: 'DELETE' });

export const archiveRampPlan = (id: string) =>
  apiFetch<{ ok: true }>(`/ramp-plans/${id}/archive`, {
    method: 'POST',
    body: {},
  });
